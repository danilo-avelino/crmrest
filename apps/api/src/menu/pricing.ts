/**
 * Preço do cardápio (F2-04). Única conta de subtotal, complementos, meio a meio, taxa e total (PLANO §0: preço só
 * no servidor). Funções puras sobre dados já carregados; dinheiro sempre em centavos inteiros.
 *
 * Nunca devolve preço 0 por falta de escolha (R6): sem o tamanho obrigatório, sai o erro `SIZE_REQUIRED`.
 */

export type HalfRule = "MAX" | "AVERAGE" | "SUM";

export type PricingOption = { id: string; name: string; priceCents: number; active: boolean; soldOut: boolean };
export type PricingGroup = { id: string; name: string; minSelect: number; maxSelect: number; options: PricingOption[] };
/** `allowsHalf` ausente vale como ligado (o tamanho aceita meio a meio). */
export type PricingSize = { id: string; name: string; priceCents: number; active: boolean; allowsHalf?: boolean };
export type PricingCategory = { id: string; allowsHalf: boolean; halfPricing: HalfRule };
export type PricingItem = {
  id: string;
  name: string;
  categoryId: string;
  /** null: o preço vem do tamanho. */
  priceCents: number | null;
  active: boolean;
  soldOut: boolean;
  allowsHalf: boolean;
  sizes: PricingSize[];
  /** Grupos de complementos ligados ao item. */
  optionGroups: PricingGroup[];
};

export type LineSelection = {
  itemId: string;
  sizeId?: string | null;
  /** Complementos escolhidos (um id por unidade). */
  optionIds?: string[];
  /** Ids dos itens das outras metades. Só uma: a pizza tem duas metades. */
  halves?: string[];
  quantity: number;
};

export type PricingErrorCode =
  | "ITEM_NOT_FOUND"
  | "ITEM_UNAVAILABLE"
  | "SIZE_REQUIRED"
  | "SIZE_NOT_FOUND"
  | "OPTION_NOT_FOUND"
  | "OPTION_UNAVAILABLE"
  | "GROUP_MIN"
  | "GROUP_MAX"
  | "HALF_NOT_ALLOWED"
  | "HALF_TOO_MANY"
  | "HALF_OTHER_CATEGORY"
  | "HALF_SIZE_MISSING"
  | "INVALID_QUANTITY";

export type PricingError = { code: PricingErrorCode; message: string; groupId?: string; itemId?: string };

export type PricedLine = {
  itemId: string;
  sizeId: string | null;
  halves: string[];
  halfRule: HalfRule | null;
  /** Preço de uma unidade sem complementos (tamanho, preço do item ou regra do meio a meio). */
  baseCents: number;
  options: { id: string; groupId: string; name: string; priceCents: number }[];
  optionsCents: number;
  unitCents: number;
  quantity: number;
  totalCents: number;
};

export type Result<T> = { ok: true; value: T } | { ok: false; errors: PricingError[] };

export type PricingCatalog = {
  items: Map<string, PricingItem> | Record<string, PricingItem>;
  categories: Map<string, PricingCategory> | Record<string, PricingCategory>;
};

const MAX_QUANTITY = 99;

const pick = <T>(source: Map<string, T> | Record<string, T>, id: string): T | undefined =>
  source instanceof Map ? source.get(id) : Object.hasOwn(source, id) ? source[id] : undefined;

const normalizeName = (name: string) =>
  name.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Preço de uma metade de cada sabor pela regra da categoria:
 * - MAX: o preço do sabor mais caro;
 * - AVERAGE: a média dos sabores, arredondada para o centavo mais próximo (meio centavo sobe: 4.995 → 5.00);
 * - SUM: a soma dos preços cheios dos sabores (escolha do usuário em 21/11/2026).
 */
export function halfPrice(rule: HalfRule, prices: number[]): number {
  if (rule === "MAX") return Math.max(...prices);
  if (rule === "AVERAGE") return Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length);
  return prices.reduce((sum, price) => sum + price, 0);
}

/** Preço do item no tamanho (sem tamanhos, o preço do item). Falta de escolha é `SIZE_REQUIRED`. */
function basePriceOf(item: PricingItem, sizeId: string | null | undefined): Result<{ cents: number; size: PricingSize | null }> {
  const sizes = item.sizes.filter((size) => size.active);
  if (sizeId) {
    const size = sizes.find((s) => s.id === sizeId);
    if (!size) return fail("SIZE_NOT_FOUND", "Esse tamanho não existe para o item.", { itemId: item.id });
    return { ok: true, value: { cents: size.priceCents, size } };
  }
  if (sizes.length > 0 || item.priceCents == null) return fail("SIZE_REQUIRED", "Escolha o tamanho.", { itemId: item.id });
  return { ok: true, value: { cents: item.priceCents, size: null } };
}

const fail = (code: PricingErrorCode, message: string, extra: Partial<PricingError> = {}): { ok: false; errors: PricingError[] } => ({
  ok: false,
  errors: [{ code, message, ...extra }],
});

const available = (item: PricingItem) => item.active && !item.soldOut;

/** Calcula uma linha da sacola. Junta todos os erros de complementos de uma vez. */
export function priceLine(catalog: PricingCatalog, selection: LineSelection): Result<PricedLine> {
  const { quantity } = selection;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY)
    return fail("INVALID_QUANTITY", `A quantidade vai de 1 a ${MAX_QUANTITY}.`);
  const item = pick(catalog.items, selection.itemId);
  if (!item) return fail("ITEM_NOT_FOUND", "Item não encontrado.", { itemId: selection.itemId });
  if (!available(item)) return fail("ITEM_UNAVAILABLE", `${item.name} não está disponível agora.`, { itemId: item.id });

  const base = basePriceOf(item, selection.sizeId);
  if (!base.ok) return base;

  // Meio a meio.
  const halves = selection.halves ?? [];
  let baseCents = base.value.cents;
  let halfRule: HalfRule | null = null;
  if (halves.length > 0) {
    if (halves.length > 1) return fail("HALF_TOO_MANY", "O meio a meio aceita só dois sabores.");
    const category = pick(catalog.categories, item.categoryId);
    if (!category?.allowsHalf || !item.allowsHalf)
      return fail("HALF_NOT_ALLOWED", `${item.name} não pode ser meio a meio.`, { itemId: item.id });
    // Meio a meio por tamanho (27/11/2026): o tamanho escolhido precisa aceitar (ex.: broto não aceita).
    if (base.value.size?.allowsHalf === false)
      return fail("HALF_NOT_ALLOWED", `O tamanho ${base.value.size.name} não aceita meio a meio.`, { itemId: item.id });
    const prices = [base.value.cents];
    for (const halfId of halves) {
      const other = pick(catalog.items, halfId);
      if (!other) return fail("ITEM_NOT_FOUND", "Sabor não encontrado.", { itemId: halfId });
      if (!available(other)) return fail("ITEM_UNAVAILABLE", `${other.name} não está disponível agora.`, { itemId: other.id });
      if (other.categoryId !== item.categoryId)
        return fail("HALF_OTHER_CATEGORY", "As duas metades precisam ser da mesma categoria.", { itemId: other.id });
      if (!other.allowsHalf) return fail("HALF_NOT_ALLOWED", `${other.name} não pode ser meio a meio.`, { itemId: other.id });
      // A outra metade no mesmo tamanho, pelo nome (cada sabor tem os próprios tamanhos).
      const size = base.value.size;
      if (size) {
        const match = other.sizes.find((s) => s.active && normalizeName(s.name) === normalizeName(size.name));
        if (!match) return fail("HALF_SIZE_MISSING", `${other.name} não tem o tamanho ${size.name}.`, { itemId: other.id });
        if (match.allowsHalf === false) return fail("HALF_NOT_ALLOWED", `${other.name} ${match.name} não pode ser meio a meio.`, { itemId: other.id });
        prices.push(match.priceCents);
      } else {
        const otherBase = basePriceOf(other, null);
        if (!otherBase.ok) return otherBase;
        prices.push(otherBase.value.cents);
      }
    }
    halfRule = category.halfPricing;
    baseCents = halfPrice(halfRule, prices);
  }

  // Complementos: só dos grupos ligados ao item, com mínimo e máximo de cada grupo.
  const errors: PricingError[] = [];
  const chosen: PricedLine["options"] = [];
  const counts = new Map<string, number>();
  for (const optionId of selection.optionIds ?? []) {
    const group = item.optionGroups.find((g) => g.options.some((o) => o.id === optionId));
    const option = group?.options.find((o) => o.id === optionId);
    if (!group || !option) {
      errors.push({ code: "OPTION_NOT_FOUND", message: "Complemento não encontrado para este item.", itemId: item.id });
      continue;
    }
    if (!option.active || option.soldOut) {
      errors.push({ code: "OPTION_UNAVAILABLE", message: `${option.name} não está disponível agora.`, groupId: group.id });
      continue;
    }
    counts.set(group.id, (counts.get(group.id) ?? 0) + 1);
    chosen.push({ id: option.id, groupId: group.id, name: option.name, priceCents: option.priceCents });
  }
  for (const group of item.optionGroups) {
    const count = counts.get(group.id) ?? 0;
    if (count < group.minSelect)
      errors.push({ code: "GROUP_MIN", message: `Escolha pelo menos ${group.minSelect} em ${group.name}.`, groupId: group.id });
    if (count > group.maxSelect)
      errors.push({ code: "GROUP_MAX", message: `Escolha até ${group.maxSelect} em ${group.name}.`, groupId: group.id });
  }
  if (errors.length) return { ok: false, errors };

  const optionsCents = chosen.reduce((sum, option) => sum + option.priceCents, 0);
  const unitCents = baseCents + optionsCents;
  return {
    ok: true,
    value: {
      itemId: item.id,
      sizeId: base.value.size?.id ?? null,
      halves,
      halfRule,
      baseCents,
      options: chosen,
      optionsCents,
      unitCents,
      quantity,
      totalCents: unitCents * quantity,
    },
  };
}

/** O que o botão "Adicionar" mostra: desabilitado com o motivo, ou o valor (R6: nunca "R$ 0,00" sem tamanho). */
export type AddButton = { disabled: true; label: string; code: PricingErrorCode } | { disabled: false; label: string; totalCents: number };

export function addButtonOf(catalog: PricingCatalog, selection: LineSelection): AddButton {
  const line = priceLine(catalog, selection);
  if (!line.ok) {
    const first = line.errors[0]!;
    return { disabled: true, label: first.code === "SIZE_REQUIRED" ? "Escolha o tamanho" : first.message, code: first.code };
  }
  return { disabled: false, label: `Adicionar ${formatCents(line.value.totalCents)}`, totalCents: line.value.totalCents };
}

/** "R$ 1.234,50". */
export function formatCents(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100).replace(/ /g, " ");
}

export type CartTotals = { lines: PricedLine[]; subtotalCents: number; deliveryFeeCents: number; totalCents: number };

/** Subtotal, taxa e total da sacola. A taxa vem do `DeliveryService` (já com o frete grátis aplicado). */
export function priceCart(
  catalog: PricingCatalog,
  selections: LineSelection[],
  deliveryFeeCents: number | ((subtotalCents: number) => number) = 0,
): Result<CartTotals> {
  const lines: PricedLine[] = [];
  const errors: PricingError[] = [];
  for (const selection of selections) {
    const line = priceLine(catalog, selection);
    if (line.ok) lines.push(line.value);
    else errors.push(...line.errors);
  }
  if (errors.length) return { ok: false, errors };
  const subtotalCents = lines.reduce((sum, line) => sum + line.totalCents, 0);
  const fee = typeof deliveryFeeCents === "function" ? deliveryFeeCents(subtotalCents) : deliveryFeeCents;
  return { ok: true, value: { lines, subtotalCents, deliveryFeeCents: fee, totalCents: subtotalCents + fee } };
}
