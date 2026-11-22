import type { TenantScope, TenantTx } from "@dishdesk/database";
import { z } from "zod";
import type { LlmTool, LlmToolContext } from "../../ai/llm-provider.js";
import { loadMenuCategories, loadMenuItems, pricingCatalogOf } from "../../menu/menu-catalog.js";
import { formatCents, type PricingCatalog } from "../../menu/pricing.js";

/** Só o que as ferramentas usam do DatabaseService (o teste passa o `withTenants` do pacote). */
export type TenantDb = { withTenants<T>(scope: TenantScope, fn: (tx: TenantTx) => Promise<T>): Promise<T> };

export type MenuAgentDeps = { db: TenantDb; now?: () => Date };

/** A conversa em que o agente atende, fixada pelo sistema ao montar as ferramentas (nunca vem do modelo). */
export type MenuAgentSession = { conversationId: string; contactId: string | null };

/** Ferramenta com o input inferido do schema. */
export const defineTool = <S extends z.ZodType>(tool: LlmTool<S>): LlmTool<S> => tool;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = LlmTool<any>;

/** Dinheiro para o modelo: o texto pronto e os centavos. */
export const money = (cents: number) => ({ texto: formatCents(cents), centavos: cents });

/** Id de item, tamanho, complemento etc. O modelo só conhece os ids que as ferramentas devolveram. */
export const Id = z.uuid();

export type Loaded = {
  tx: TenantTx;
  tenantId: string;
  now: Date;
  settings: unknown;
  menuId: string;
};

/** Resposta de erro para o modelo: código e o que fazer. */
export const refuse = (codigo: string, dica: string, extra: Record<string, unknown> = {}) => ({ ok: false as const, codigo, dica, ...extra });

/**
 * Abre a transação no restaurante da conversa (`ctx.tenantId`, do sistema) e carrega o cardápio. Sem cardápio
 * ativo: `null`, e a ferramenta responde MENU_INDISPONIVEL.
 */
export async function withMenu<T>(
  deps: MenuAgentDeps,
  ctx: LlmToolContext,
  fn: (loaded: Loaded) => Promise<T>,
): Promise<T | ReturnType<typeof refuse>> {
  const tenantId = ctx.tenantId;
  const now = deps.now?.() ?? new Date();
  return deps.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
    const [tenant, menu] = await Promise.all([
      tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }),
      tx.menu.findUnique({ where: { tenantId }, select: { id: true, active: true } }),
    ]);
    if (!tenant || !menu?.active) return refuse("MENU_INDISPONIVEL", "O restaurante não tem cardápio ativo: chame a equipe.");
    return fn({ tx, tenantId, now, settings: tenant.settings, menuId: menu.id });
  });
}

/** Itens, categorias e o catálogo do preço, carregados juntos. */
export async function loadCatalog({ tx, tenantId, menuId, now }: Loaded) {
  const [categories, items] = await Promise.all([loadMenuCategories(tx, tenantId, menuId), loadMenuItems(tx, tenantId, menuId)]);
  return { categories, items, catalog: pricingCatalogOf(categories, items, now) };
}

export type Catalog = Awaited<ReturnType<typeof loadCatalog>>;

/** Menor preço do item: o do item ou o do menor tamanho. */
export function fromPriceCents(item: { priceCents: number | null; sizes: { priceCents: number }[] }): number | null {
  if (item.sizes.length) return Math.min(...item.sizes.map((s) => s.priceCents));
  return item.priceCents;
}

/** O item está à venda agora (ativo, no horário dele e da categoria, sem esgotar)? */
export function availableNow(catalog: PricingCatalog, itemId: string): boolean {
  const item = catalog.items instanceof Map ? catalog.items.get(itemId) : undefined;
  return !!item && item.active && !item.soldOut;
}
