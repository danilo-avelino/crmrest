import type { TenantTx } from "@dishdesk/database";
import type { PricingCatalog, PricingItem } from "./pricing.js";

/**
 * Leitura do cardápio para o preço (F2-04): a mesma no cardápio público e no agente de pedidos, para os dois
 * calcularem com o mesmo catálogo. `tenantId` filtra explicitamente além da RLS.
 */

type Slot = { weekday: number; startMinute: number; endMinute: number };

/** Brasília não tem horário de verão desde 2019: UTC−3 fixo (o mesmo de delivery.ts). */
const BRASILIA_OFFSET_MS = -180 * 60_000;

/**
 * Faixas de horário (MenuAvailability) que valem agora. Sem faixa: sempre. Fim exclusivo; fim menor ou igual ao
 * início passa da meia-noite.
 */
export function availableAt(slots: Slot[], at: Date): boolean {
  if (!slots.length) return true;
  const local = new Date(at.getTime() + BRASILIA_OFFSET_MS);
  const day = local.getUTCDay();
  const now = local.getUTCHours() * 60 + local.getUTCMinutes();
  return slots.some((s) => {
    const wraps = s.endMinute <= s.startMinute;
    if (s.weekday === day && now >= s.startMinute && (wraps || now < s.endMinute)) return true;
    return wraps && s.weekday === (day + 6) % 7 && now < s.endMinute;
  });
}

const SLOT = { select: { weekday: true, startMinute: true, endMinute: true } } as const;

/** Itens visíveis (ativos, de categoria ativa) com o que a ficha e o preço precisam. */
export function loadMenuItems(tx: TenantTx, tenantId: string, menuId: string, itemId?: string) {
  return tx.menuItem.findMany({
    where: { tenantId, active: true, category: { menuId, active: true }, ...(itemId ? { id: itemId } : {}) },
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      categoryId: true,
      name: true,
      description: true,
      priceCents: true,
      promoPriceCents: true,
      photoUrl: true,
      active: true,
      soldOut: true,
      allowsHalf: true,
      ingredients: true,
      allergens: true,
      servesPeople: true,
      tags: true,
      availabilities: SLOT,
      sizes: { where: { active: true }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true, priceCents: true, active: true } },
      optionGroups: {
        orderBy: { sortOrder: "asc" },
        select: {
          group: {
            select: {
              id: true,
              name: true,
              minSelect: true,
              maxSelect: true,
              options: {
                where: { active: true },
                orderBy: { sortOrder: "asc" },
                select: { id: true, name: true, priceCents: true, active: true, soldOut: true },
              },
            },
          },
        },
      },
    },
  });
}

/** Preço que vale agora: o promocional, quando o item tem (só itens sem tamanhos). */
export function effectivePrice(item: { priceCents: number | null; promoPriceCents: number | null }): number | null {
  return item.priceCents != null && item.promoPriceCents != null && item.promoPriceCents < item.priceCents ? item.promoPriceCents : item.priceCents;
}

export function loadMenuCategories(tx: TenantTx, tenantId: string, menuId: string) {
  return tx.menuCategory.findMany({
    where: { tenantId, menuId, active: true },
    orderBy: { sortOrder: "asc" },
    select: { id: true, name: true, description: true, allowsHalf: true, halfPricing: true, availabilities: SLOT },
  });
}

export type LoadedMenuItem = Awaited<ReturnType<typeof loadMenuItems>>[number];
export type LoadedMenuCategory = Awaited<ReturnType<typeof loadMenuCategories>>[number];

/** Catálogo do `priceLine`. Fora do horário do item ou da categoria conta como indisponível. */
export function pricingCatalogOf(categories: LoadedMenuCategory[], items: LoadedMenuItem[], now: Date): PricingCatalog {
  const categoryNow = new Map(categories.map((c) => [c.id, availableAt(c.availabilities, now)]));
  return {
    categories: new Map(categories.map((c) => [c.id, { id: c.id, allowsHalf: c.allowsHalf, halfPricing: c.halfPricing }])),
    items: new Map(
      items.map((item): [string, PricingItem] => [
        item.id,
        {
          id: item.id,
          name: item.name,
          categoryId: item.categoryId,
          priceCents: effectivePrice(item),
          active: item.active && (categoryNow.get(item.categoryId) ?? false) && availableAt(item.availabilities, now),
          soldOut: item.soldOut,
          allowsHalf: item.allowsHalf,
          sizes: item.sizes,
          optionGroups: item.optionGroups.map(({ group }) => group),
        },
      ]),
    ),
  };
}
