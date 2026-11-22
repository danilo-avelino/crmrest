import { randomUUID } from "node:crypto";
import type { TenantTx } from "@dishdesk/database";
import { BadRequestException, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { DatabaseService } from "../core/database.service.js";
import { adminScope } from "../settings/tenant-admin.js";
import { ImportFileError, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, type ImportRow, planImport, readMenuCsv } from "./menu-import.js";
import { ensureMenu, requireModule } from "./menu.service.js";

export const ImportPreviewRequest = z.object({ csv: z.string().max(IMPORT_MAX_BYTES) });
export type ImportPreviewRequest = z.infer<typeof ImportPreviewRequest>;

const strings = z.array(z.string().max(200)).max(100);
const nullableCents = z.number().int().nullable();
/** As linhas que o painel devolve do preview; o servidor valida de novo (limites, duplicados e o que já existe). */
export const ImportCommitRequest = z.object({
  rows: z
    .array(
      z.object({
        line: z.number().int().min(1),
        category: z.string().max(200),
        item: z.string().max(200),
        description: z.string().max(2_500).nullable(),
        priceCents: nullableCents,
        size: z.string().max(200).nullable(),
        sizePriceCents: nullableCents,
        ingredients: strings,
        allergens: strings,
        servesPeople: z.number().int().nullable(),
        tags: strings,
        synonyms: strings,
      }),
    )
    .min(1)
    .max(IMPORT_MAX_ROWS),
});
export type ImportCommitRequest = z.infer<typeof ImportCommitRequest>;

/** Importação do cardápio por CSV (F2-09): só o administrador, com o módulo MENU ligado. */
@Injectable()
export class MenuImportService {
  constructor(private readonly db: DatabaseService) {}

  /** Lê o arquivo e mostra o que seria criado, sem gravar nada. */
  preview(auth: RequestAuth, tenantId: string, body: ImportPreviewRequest) {
    return this.db.withTenants(adminScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      let rows: ImportRow[];
      try {
        rows = readMenuCsv(body.csv);
      } catch (error) {
        if (error instanceof ImportFileError) throw new BadRequestException(error.message);
        throw error;
      }
      return planImport(rows, await existingNames(tx, tenantId));
    });
  }

  /** Cria categorias, itens e tamanhos de uma vez (tudo ou nada). Qualquer linha com erro recusa a importação inteira. */
  commit(auth: RequestAuth, tenantId: string, body: ImportCommitRequest) {
    return this.db.withTenants(adminScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      return commitImportRows(tx, tenantId, body.rows);
    });
  }
}

/**
 * Grava as linhas já revisadas (CSV, foto/PDF ou iFood): valida de novo e cria categorias, itens e tamanhos de uma vez.
 * Qualquer linha com erro recusa a importação inteira. Quem chama confere o acesso e o módulo.
 */
export async function commitImportRows(tx: TenantTx, tenantId: string, input: ImportCommitRequest["rows"]) {
  const rows: ImportRow[] = input.map((row) => ({ ...row, errors: [] }));
  const { rows: checked, plan, counts } = planImport(rows, await existingNames(tx, tenantId));
  const bad = checked.find((row) => row.errors.length);
  if (bad) throw new BadRequestException(`Linha ${bad.line}: ${bad.errors[0]}`);

  const menuId = await ensureMenu(tx, tenantId);
  const categories = await tx.menuCategory.findMany({ where: { tenantId, menuId }, select: { id: true, name: true } });
  const last = await tx.menuCategory.aggregate({ where: { tenantId, menuId }, _max: { sortOrder: true } });
  let nextCategory = (last._max.sortOrder ?? -1) + 1;
  const newCategories: { id: string; tenantId: string; menuId: string; name: string; sortOrder: number }[] = [];
  const items: Record<string, unknown>[] = [];
  const sizes: Record<string, unknown>[] = [];
  for (const entry of plan) {
    let categoryId = categories.find((category) => category.name.trim().toLowerCase() === entry.name.toLowerCase())?.id;
    let nextItem = 0;
    if (!categoryId) {
      categoryId = randomUUID();
      newCategories.push({ id: categoryId, tenantId, menuId, name: entry.name, sortOrder: nextCategory++ });
    } else {
      const lastItem = await tx.menuItem.aggregate({ where: { tenantId, categoryId }, _max: { sortOrder: true } });
      nextItem = (lastItem._max.sortOrder ?? -1) + 1;
    }
    for (const item of entry.items) {
      const id = randomUUID();
      const { sizes: itemSizes, ...fields } = item;
      items.push({ id, tenantId, categoryId, sortOrder: nextItem++, ...fields });
      itemSizes.forEach((size, sortOrder) => sizes.push({ tenantId, itemId: id, sortOrder, ...size }));
    }
  }
  await tx.menuCategory.createMany({ data: newCategories });
  await tx.menuItem.createMany({ data: items as never });
  await tx.menuItemSize.createMany({ data: sizes as never });
  return { categories: newCategories.length, items: counts.items, sizes: counts.sizes };
}

/** Categoria (minúscula) -> nomes (minúsculos) dos itens que o restaurante já tem, para não duplicar. */
export async function existingNames(tx: TenantTx, tenantId: string): Promise<Map<string, Set<string>>> {
  const categories = await tx.menuCategory.findMany({ where: { tenantId }, select: { name: true, items: { select: { name: true } } } });
  return new Map(categories.map((category) => [category.name.trim().toLowerCase(), new Set(category.items.map((item) => item.name.trim().toLowerCase()))]));
}
