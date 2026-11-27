import type { TenantTx } from "@dishdesk/database";
import { businessHoursOf, closingTimeAt, DEFAULT_MENU_ACCENT, effectivePaymentMethods, closedAt, menuStoreOf, pausedOf, reopeningAt, tenantBlock } from "@dishdesk/shared";
import { Injectable, NotFoundException } from "@nestjs/common";
import { DatabaseService } from "../core/database.service.js";
import { type DeliveryAddress, type FulfillmentMode, feeRangeOf, quoteDelivery, scheduleSlots } from "../menu/delivery.js";
import { liveNotices } from "../menu/menu-notices.js";
import { availableAt, effectivePrice, loadMenuCategories, loadMenuItems, pricingCatalogOf } from "../menu/menu-catalog.js";
import { addButtonOf, type LineSelection, priceLine } from "../menu/pricing.js";

type Store = { tenantId: string; name: string; settings: unknown };

export { availableAt };

const NOT_FOUND = "Cardápio não encontrado.";

/**
 * Cardápio público (F0-04, F3-01), sem login. O restaurante vem só do slug (`app.public_menu_tenant`, que já exige
 * restaurante ativo e o módulo MENU); assinatura vencida ou cardápio desligado também respondem o mesmo 404, sem dizer
 * o motivo. Nada interno sai daqui: nota para a IA, sinônimos, custo e ids de tenant ficam de fora.
 */
@Injectable()
export class PublicMenuService {
  constructor(private readonly db: DatabaseService) {}

  async withStore<T>(slug: string, fn: (tx: TenantTx, store: Store & { menuId: string }) => Promise<T>): Promise<T> {
    const [row] = await this.db.client.$queryRaw<{ id: string | null }[]>`SELECT app.public_menu_tenant(${slug}) AS id`;
    const tenantId = row?.id;
    if (!tenantId) throw new NotFoundException(NOT_FOUND);
    return this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      const menu = await tx.menu.findUnique({ where: { tenantId }, select: { id: true, active: true } });
      if (!tenant || tenantBlock(tenant) || !menu?.active) throw new NotFoundException(NOT_FOUND);
      return fn(tx, { tenantId, name: tenant.name, settings: tenant.settings, menuId: menu.id });
    });
  }

  /** Itens visíveis (ativos, de categoria ativa) com o que a ficha e o preço precisam. */
  private loadItems(tx: TenantTx, tenantId: string, menuId: string, itemId?: string) {
    return loadMenuItems(tx, tenantId, menuId, itemId);
  }

  private loadCategories(tx: TenantTx, tenantId: string, menuId: string) {
    return loadMenuCategories(tx, tenantId, menuId);
  }

  menu(slug: string, now = new Date()) {
    return this.withStore(slug, async (tx, store) => {
      const [categories, items] = await Promise.all([
        this.loadCategories(tx, store.tenantId, store.menuId),
        this.loadItems(tx, store.tenantId, store.menuId),
      ]);
      return {
        store: storeInfo(store, now),
        // Avisos no ar agora (N5): faixas no topo, em sequência.
        notices: await liveNotices(tx, store.tenantId, now),
        categories: categories.map((category) => {
          const categoryNow = availableAt(category.availabilities, now);
          return {
            id: category.id,
            name: category.name,
            description: category.description,
            allowsHalf: category.allowsHalf,
            halfPricing: category.halfPricing,
            availableNow: categoryNow,
            items: items
              .filter((item) => item.categoryId === category.id)
              .map((item) => publicItem(item, category.allowsHalf, categoryNow, now)),
          };
        }),
      };
    });
  }

  item(slug: string, itemId: string, now = new Date()) {
    return this.withStore(slug, async (tx, store) => {
      const [item] = await this.loadItems(tx, store.tenantId, store.menuId, itemId);
      if (!item) throw new NotFoundException("Item não encontrado.");
      const category = (await this.loadCategories(tx, store.tenantId, store.menuId)).find((c) => c.id === item.categoryId)!;
      return publicItem(item, category.allowsHalf, availableAt(category.availabilities, now), now);
    });
  }

  /** Confere uma escolha (tamanho, complementos, meio a meio) com a mesma conta do checkout. */
  price(slug: string, selection: LineSelection, now = new Date()) {
    return this.withStore(slug, async (tx, store) => {
      const [categories, items] = await Promise.all([
        this.loadCategories(tx, store.tenantId, store.menuId),
        this.loadItems(tx, store.tenantId, store.menuId),
      ]);
      const catalog = pricingCatalogOf(categories, items, now);
      const line = priceLine(catalog, selection);
      const button = addButtonOf(catalog, selection);
      return line.ok ? { ok: true as const, line: line.value, button } : { ok: false as const, errors: line.errors, button };
    });
  }

  deliveryQuote(slug: string, input: { mode: FulfillmentMode; subtotalCents: number; address?: DeliveryAddress }) {
    return this.withStore(slug, async (_tx, store) => quoteDelivery(menuStoreOf(store.settings), input));
  }

  slots(slug: string, now = new Date()) {
    return this.withStore(slug, async (_tx, store) => ({
      slots: scheduleSlots(menuStoreOf(store.settings), businessHoursOf(store.settings), now),
    }));
  }
}

function storeInfo(store: Store, now: Date) {
  const menuStore = menuStoreOf(store.settings);
  const hours = businessHoursOf(store.settings);
  const closed = closedAt(hours, now);
  const status = pausedOf(store.settings) ? "paused" : closed ? "closed" : "open";
  return {
    name: store.name,
    logoUrl: menuStore.logoUrl ?? null,
    coverUrl: menuStore.coverUrl ?? null,
    accentColor: menuStore.accentColor ?? DEFAULT_MENU_ACCENT,
    brandTheme: menuStore.brandTheme ?? false,
    city: menuStore.city || menuStore.address.city || null,
    address: addressLine(menuStore.address),
    phone: menuStore.phone || null,
    cnpj: menuStore.cnpj || null,
    about: menuStore.about || null,
    /** Horário da semana (0 = domingo), turnos "HH:MM"; vazio quando o restaurante não configurou horário. */
    weekHours: hours.enabled ? hours.days : null,
    closesAt: status === "open" && hours.enabled ? closingTimeAt(hours, now) : null,
    status,
    nextOpening: status === "closed" ? reopeningAt(hours, now) : null,
    feeRange: feeRangeOf(menuStore),
    freeDeliveryFromCents: menuStore.freeDeliveryFromCents ?? null,
    minOrderCents: menuStore.minOrderCents,
    pickupEnabled: menuStore.pickupEnabled,
    deliveryEta: { minMinutes: menuStore.deliveryMinMinutes, maxMinutes: menuStore.deliveryMaxMinutes },
    paymentMethods: effectivePaymentMethods(menuStore),
    schedulingEnabled: menuStore.scheduling.enabled,
    /** Pixel da Meta (F7-03): o navegador só carrega com o consentimento do visitante. */
    metaPixelId: menuStore.metaPixelId ?? null,
  };
}

type LoadedItem = Awaited<ReturnType<PublicMenuService["loadItems"]>>[number];

function publicItem(item: LoadedItem, categoryAllowsHalf: boolean, categoryNow: boolean, now: Date) {
  return {
    id: item.id,
    categoryId: item.categoryId,
    name: item.name,
    description: item.description,
    priceCents: effectivePrice(item),
    /** Preço cheio, quando o item está em promoção (o cardápio mostra riscado); null sem promoção. */
    regularPriceCents: effectivePrice(item) !== item.priceCents ? item.priceCents : null,
    photoUrl: item.photoUrl,
    soldOut: item.soldOut,
    availableNow: categoryNow && availableAt(item.availabilities, now),
    allowsHalf: categoryAllowsHalf && item.allowsHalf,
    sizes: item.sizes.map(({ id, name, priceCents, allowsHalf }) => ({ id, name, priceCents, allowsHalf })),
    optionGroups: item.optionGroups.map(({ group }) => ({
      id: group.id,
      name: group.name,
      minSelect: group.minSelect,
      maxSelect: group.maxSelect,
      options: group.options.map(({ id, name, priceCents, soldOut }) => ({ id, name, priceCents, soldOut })),
    })),
    tags: item.tags,
    ingredients: item.ingredients,
    allergens: item.allergens,
    servesPeople: item.servesPeople,
  };
}

/** "Rua X, 123 · Bairro" (só o que foi preenchido); null sem rua. */
function addressLine(address: ReturnType<typeof menuStoreOf>["address"]): string | null {
  if (!address.street) return null;
  const street = address.number ? `${address.street}, ${address.number}` : address.street;
  return [street, address.district].filter(Boolean).join(" · ");
}
