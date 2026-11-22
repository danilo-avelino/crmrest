import type { TenantTx } from "@dishdesk/database";
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { z } from "zod";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { DatabaseService } from "../core/database.service.js";
import { adminScope, memberScope } from "../settings/tenant-admin.js";
import type {
  AvailabilityRequest,
  CategoryPatch,
  CategoryRequest,
  ItemPatch,
  ItemRequest,
  OptionGroupPatch,
  OptionGroupRequest,
  OptionPatch,
  OptionRequest,
  SizesRequest,
} from "./menu.dto.js";
import { topItems } from "./menu-stats.js";

type Body<T extends z.ZodType> = z.output<T>;

const SLOT = { weekday: true, startMinute: true, endMinute: true } as const;
const ITEM_INCLUDE = {
  sizes: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true, priceCents: true, sortOrder: true, active: true } },
  optionGroups: { orderBy: { sortOrder: "asc" }, select: { groupId: true, sortOrder: true } },
  availabilities: { select: SLOT },
  pairsWith: { select: { pairedItemId: true } },
} as const;

/**
 * Cardápio próprio (docs/cardapio-ia): CRUD de categorias, itens, tamanhos, grupos de complementos, horários e "combina com".
 * Todo acesso exige o módulo MENU ligado no restaurante; só o administrador altera. O restaurante vem da membership
 * (`memberScope`/`adminScope`), nunca de um id solto: toda busca por id inclui o `tenantId` e a RLS confere de novo.
 */
@Injectable()
export class MenuService {
  constructor(private readonly db: DatabaseService) {}

  private read<T>(auth: RequestAuth, tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.db.withTenants(memberScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      return fn(tx);
    });
  }

  private write<T>(auth: RequestAuth, tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.db.withTenants(adminScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      return fn(tx);
    });
  }

  // ---- leitura ----

  /** O cardápio inteiro: categorias com itens (e o que a ficha precisa) e os grupos de complementos. */
  tree(auth: RequestAuth, tenantId: string) {
    return this.read(auth, tenantId, async (tx) => {
      const menu = await tx.menu.findUnique({ where: { tenantId }, select: { id: true, name: true, active: true } });
      if (!menu) return { menu: null, categories: [], optionGroups: [] };
      const [categories, optionGroups] = await Promise.all([
        tx.menuCategory.findMany({
          where: { tenantId, menuId: menu.id },
          orderBy: { sortOrder: "asc" },
          include: { availabilities: { select: SLOT }, items: { orderBy: { sortOrder: "asc" }, include: ITEM_INCLUDE } },
        }),
        tx.menuOptionGroup.findMany({
          where: { tenantId, menuId: menu.id },
          orderBy: { sortOrder: "asc" },
          include: { options: { orderBy: { sortOrder: "asc" } } },
        }),
      ]);
      return { menu, categories, optionGroups };
    });
  }

  // ---- categorias ----

  createCategory(auth: RequestAuth, tenantId: string, body: Body<typeof CategoryRequest>) {
    return this.write(auth, tenantId, async (tx) => {
      const menuId = await ensureMenu(tx, tenantId);
      const last = await tx.menuCategory.aggregate({ where: { tenantId, menuId }, _max: { sortOrder: true } });
      return tx.menuCategory.create({ data: { tenantId, menuId, ...body, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
    });
  }

  updateCategory(auth: RequestAuth, tenantId: string, id: string, body: Body<typeof CategoryPatch>) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuCategory.findFirst({ where: { id, tenantId }, select: { id: true } }), "Categoria");
      return tx.menuCategory.update({ where: { id }, data: body });
    });
  }

  deleteCategory(auth: RequestAuth, tenantId: string, id: string) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuCategory.findFirst({ where: { id, tenantId }, select: { id: true } }), "Categoria");
      await tx.menuCategory.delete({ where: { id } });
    });
  }

  reorderCategories(auth: RequestAuth, tenantId: string, ids: string[]) {
    return this.write(auth, tenantId, async (tx) => {
      await assertAll(ids, tx.menuCategory.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true } }), "Categoria");
      await applyOrder(ids, (id, sortOrder) => tx.menuCategory.update({ where: { id }, data: { sortOrder } }));
    });
  }

  setCategoryAvailability(auth: RequestAuth, tenantId: string, id: string, body: Body<typeof AvailabilityRequest>) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuCategory.findFirst({ where: { id, tenantId }, select: { id: true } }), "Categoria");
      await tx.menuAvailability.deleteMany({ where: { tenantId, categoryId: id } });
      await tx.menuAvailability.createMany({ data: body.slots.map((slot) => ({ tenantId, categoryId: id, ...slot })) });
      return tx.menuAvailability.findMany({ where: { tenantId, categoryId: id }, select: SLOT });
    });
  }

  // ---- itens ----

  createItem(auth: RequestAuth, tenantId: string, body: Body<typeof ItemRequest>) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuCategory.findFirst({ where: { id: body.categoryId, tenantId }, select: { id: true } }), "Categoria");
      const last = await tx.menuItem.aggregate({ where: { tenantId, categoryId: body.categoryId }, _max: { sortOrder: true } });
      return tx.menuItem.create({ data: { tenantId, ...body, sortOrder: (last._max.sortOrder ?? -1) + 1 }, include: ITEM_INCLUDE });
    });
  }

  updateItem(auth: RequestAuth, tenantId: string, id: string, body: Body<typeof ItemPatch>) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuItem.findFirst({ where: { id, tenantId }, select: { id: true } }), "Item");
      if (body.categoryId) {
        await requireRow(tx.menuCategory.findFirst({ where: { id: body.categoryId, tenantId }, select: { id: true } }), "Categoria");
      }
      return tx.menuItem.update({ where: { id }, data: body, include: ITEM_INCLUDE });
    });
  }

  deleteItem(auth: RequestAuth, tenantId: string, id: string) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuItem.findFirst({ where: { id, tenantId }, select: { id: true } }), "Item");
      await tx.menuItem.delete({ where: { id } });
    });
  }

  /** Esgotado em um clique: o item continua no cardápio, mas não pode ser pedido. */
  setSoldOut(auth: RequestAuth, tenantId: string, id: string, soldOut: boolean) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuItem.findFirst({ where: { id, tenantId }, select: { id: true } }), "Item");
      return tx.menuItem.update({ where: { id }, data: { soldOut }, select: { id: true, soldOut: true } });
    });
  }

  /** Arquivar tira o item do cardápio sem perder o histórico dos pedidos (`active=false`); desarquivar o devolve. */
  setActive(auth: RequestAuth, tenantId: string, id: string, active: boolean) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuItem.findFirst({ where: { id, tenantId }, select: { id: true } }), "Item");
      return tx.menuItem.update({ where: { id }, data: { active }, select: { id: true, active: true } });
    });
  }

  reorderItems(auth: RequestAuth, tenantId: string, categoryId: string, ids: string[]) {
    return this.write(auth, tenantId, async (tx) => {
      await assertAll(ids, tx.menuItem.findMany({ where: { tenantId, categoryId, id: { in: ids } }, select: { id: true } }), "Item");
      await applyOrder(ids, (id, sortOrder) => tx.menuItem.update({ where: { id }, data: { sortOrder } }));
    });
  }

  /** Cópia do item no fim da mesma categoria, com tamanhos, grupos de complementos, horários e "combina com". */
  duplicateItem(auth: RequestAuth, tenantId: string, id: string) {
    return this.write(auth, tenantId, async (tx) => {
      const source = await tx.menuItem.findFirst({ where: { id, tenantId }, include: ITEM_INCLUDE });
      if (!source) throw new NotFoundException("Item não encontrado.");
      const last = await tx.menuItem.aggregate({ where: { tenantId, categoryId: source.categoryId }, _max: { sortOrder: true } });
      const { id: _id, createdAt: _c, updatedAt: _u, sizes, optionGroups, availabilities, pairsWith, ...fields } = source;
      return tx.menuItem.create({
        data: {
          ...fields,
          name: `${source.name} (cópia)`.slice(0, 120),
          soldOut: false,
          sortOrder: (last._max.sortOrder ?? -1) + 1,
          sizes: { create: sizes.map(({ id: _s, ...size }) => ({ tenantId, ...size })) },
          optionGroups: { create: optionGroups.map((link) => ({ tenantId, ...link })) },
          availabilities: { create: availabilities.map((slot) => ({ tenantId, ...slot })) },
          pairsWith: { create: pairsWith.map((pair) => ({ tenantId, pairedItemId: pair.pairedItemId })) },
        },
        include: ITEM_INCLUDE,
      });
    });
  }

  /** Troca todos os tamanhos do item pelos enviados (a ordem da lista é a ordem do cardápio). */
  setSizes(auth: RequestAuth, tenantId: string, id: string, body: Body<typeof SizesRequest>) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuItem.findFirst({ where: { id, tenantId }, select: { id: true } }), "Item");
      await tx.menuItemSize.deleteMany({ where: { tenantId, itemId: id } });
      await tx.menuItemSize.createMany({ data: body.sizes.map((size, sortOrder) => ({ tenantId, itemId: id, ...size, sortOrder })) });
      return tx.menuItemSize.findMany({
        where: { tenantId, itemId: id },
        orderBy: { sortOrder: "asc" },
        select: { id: true, name: true, priceCents: true, sortOrder: true, active: true },
      });
    });
  }

  setItemAvailability(auth: RequestAuth, tenantId: string, id: string, body: Body<typeof AvailabilityRequest>) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuItem.findFirst({ where: { id, tenantId }, select: { id: true } }), "Item");
      await tx.menuAvailability.deleteMany({ where: { tenantId, itemId: id } });
      await tx.menuAvailability.createMany({ data: body.slots.map((slot) => ({ tenantId, itemId: id, ...slot })) });
      return tx.menuAvailability.findMany({ where: { tenantId, itemId: id }, select: SLOT });
    });
  }

  /** "Combina com": troca a lista de itens que a IA sugere ao adicionar este. */
  setPairings(auth: RequestAuth, tenantId: string, id: string, itemIds: string[]) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuItem.findFirst({ where: { id, tenantId }, select: { id: true } }), "Item");
      const unique = [...new Set(itemIds)];
      if (unique.includes(id)) throw new BadRequestException("Um item não combina com ele mesmo.");
      await assertAll(unique, tx.menuItem.findMany({ where: { tenantId, id: { in: unique } }, select: { id: true } }), "Item");
      await tx.menuItemPairing.deleteMany({ where: { tenantId, itemId: id } });
      await tx.menuItemPairing.createMany({ data: unique.map((pairedItemId) => ({ tenantId, itemId: id, pairedItemId })) });
      return { itemIds: unique };
    });
  }

  // ---- grupos de complementos ----

  createOptionGroup(auth: RequestAuth, tenantId: string, body: Body<typeof OptionGroupRequest>) {
    return this.write(auth, tenantId, async (tx) => {
      const menuId = await ensureMenu(tx, tenantId);
      const last = await tx.menuOptionGroup.aggregate({ where: { tenantId, menuId }, _max: { sortOrder: true } });
      return tx.menuOptionGroup.create({
        data: { tenantId, menuId, ...body, sortOrder: (last._max.sortOrder ?? -1) + 1 },
        include: { options: true },
      });
    });
  }

  updateOptionGroup(auth: RequestAuth, tenantId: string, id: string, body: Body<typeof OptionGroupPatch>) {
    return this.write(auth, tenantId, async (tx) => {
      const group = await tx.menuOptionGroup.findFirst({ where: { id, tenantId }, select: { minSelect: true, maxSelect: true } });
      if (!group) throw new NotFoundException("Grupo não encontrado.");
      if ((body.minSelect ?? group.minSelect) > (body.maxSelect ?? group.maxSelect)) {
        throw new BadRequestException("O mínimo não pode passar do máximo.");
      }
      return tx.menuOptionGroup.update({ where: { id }, data: body, include: { options: { orderBy: { sortOrder: "asc" } } } });
    });
  }

  deleteOptionGroup(auth: RequestAuth, tenantId: string, id: string) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuOptionGroup.findFirst({ where: { id, tenantId }, select: { id: true } }), "Grupo");
      await tx.menuOptionGroup.delete({ where: { id } });
    });
  }

  reorderOptionGroups(auth: RequestAuth, tenantId: string, ids: string[]) {
    return this.write(auth, tenantId, async (tx) => {
      await assertAll(ids, tx.menuOptionGroup.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true } }), "Grupo");
      await applyOrder(ids, (id, sortOrder) => tx.menuOptionGroup.update({ where: { id }, data: { sortOrder } }));
    });
  }

  createOption(auth: RequestAuth, tenantId: string, groupId: string, body: Body<typeof OptionRequest>) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuOptionGroup.findFirst({ where: { id: groupId, tenantId }, select: { id: true } }), "Grupo");
      const last = await tx.menuOption.aggregate({ where: { tenantId, groupId }, _max: { sortOrder: true } });
      return tx.menuOption.create({ data: { tenantId, groupId, ...body, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
    });
  }

  updateOption(auth: RequestAuth, tenantId: string, id: string, body: Body<typeof OptionPatch>) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuOption.findFirst({ where: { id, tenantId }, select: { id: true } }), "Complemento");
      return tx.menuOption.update({ where: { id }, data: body });
    });
  }

  deleteOption(auth: RequestAuth, tenantId: string, id: string) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuOption.findFirst({ where: { id, tenantId }, select: { id: true } }), "Complemento");
      await tx.menuOption.delete({ where: { id } });
    });
  }

  /** Troca os grupos de complementos do item pelos enviados (a ordem da lista é a ordem na ficha). */
  setItemOptionGroups(auth: RequestAuth, tenantId: string, id: string, groupIds: string[]) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuItem.findFirst({ where: { id, tenantId }, select: { id: true } }), "Item");
      const unique = [...new Set(groupIds)];
      await assertAll(unique, tx.menuOptionGroup.findMany({ where: { tenantId, id: { in: unique } }, select: { id: true } }), "Grupo");
      await tx.menuItemOptionGroup.deleteMany({ where: { tenantId, itemId: id } });
      await tx.menuItemOptionGroup.createMany({ data: unique.map((groupId, sortOrder) => ({ tenantId, itemId: id, groupId, sortOrder })) });
      return { groupIds: unique };
    });
  }

  linkOptionGroup(auth: RequestAuth, tenantId: string, id: string, groupId: string) {
    return this.write(auth, tenantId, async (tx) => {
      await requireRow(tx.menuItem.findFirst({ where: { id, tenantId }, select: { id: true } }), "Item");
      await requireRow(tx.menuOptionGroup.findFirst({ where: { id: groupId, tenantId }, select: { id: true } }), "Grupo");
      const last = await tx.menuItemOptionGroup.aggregate({ where: { tenantId, itemId: id }, _max: { sortOrder: true } });
      await tx.menuItemOptionGroup.upsert({
        where: { itemId_groupId: { itemId: id, groupId } },
        create: { tenantId, itemId: id, groupId, sortOrder: (last._max.sortOrder ?? -1) + 1 },
        update: {},
      });
      return { itemId: id, groupId };
    });
  }

  unlinkOptionGroup(auth: RequestAuth, tenantId: string, id: string, groupId: string) {
    return this.write(auth, tenantId, async (tx) => {
      await tx.menuItemOptionGroup.deleteMany({ where: { tenantId, itemId: id, groupId } });
    });
  }

  /** Mais vendidos (F2-11), para o painel; o agente usa `topItems` direto. */
  top(auth: RequestAuth, tenantId: string, categoryId: string | undefined, days: number, limit: number) {
    return this.read(auth, tenantId, (tx) => topItems(tx, { tenantId, categoryId, days, limit }));
  }
}

/** Módulo MENU ligado pela plataforma; sem ele o cardápio inteiro responde 403. */
export async function requireModule(tx: TenantTx, tenantId: string): Promise<void> {
  const module = await tx.tenantModule.findUnique({ where: { tenantId_module: { tenantId, module: "MENU" } }, select: { id: true } });
  if (!module) throw new ForbiddenException("O módulo Cardápio não está ativo neste restaurante.");
}

/** Cada restaurante tem um cardápio (`tenantId` único): nasce no primeiro uso. */
export async function ensureMenu(tx: TenantTx, tenantId: string): Promise<string> {
  const menu = await tx.menu.upsert({ where: { tenantId }, create: { tenantId, name: "Cardápio" }, update: {}, select: { id: true } });
  return menu.id;
}

async function requireRow(lookup: Promise<unknown>, label: string): Promise<void> {
  if (!(await lookup)) throw new NotFoundException(`${label} não encontrado.`);
}

/** Todos os ids enviados precisam existir no restaurante (e sem repetição). */
async function assertAll(ids: string[], found: Promise<{ id: string }[]>, label: string): Promise<void> {
  if (new Set(ids).size !== ids.length || (await found).length !== ids.length) {
    throw new NotFoundException(`${label} não encontrado.`);
  }
}

async function applyOrder(ids: string[], update: (id: string, sortOrder: number) => Promise<unknown>): Promise<void> {
  for (const [index, id] of ids.entries()) await update(id, index);
}
