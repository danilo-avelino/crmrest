// Ficha do item do cardápio público (F3-04): o que o cliente escolheu, o pedido de preço para a API e as regras
// que a tela mostra (rótulo dos grupos, regra do meio a meio). Sem React, para testar sozinho. O preço vem sempre da
// API (POST /api/public/menu/:slug/price); aqui só se monta o pedido e se confere mínimo e máximo para o aviso.

import { money, orderable, type PublicMenuCategory, type PublicMenuItem } from "./public-menu";

/** Escolha em andamento na ficha. `options` guarda quantas unidades de cada complemento (combo aceita repetir). */
export type ItemSelection = {
  itemId: string;
  sizeId: string | null;
  /** Meio a meio ligado. */
  halfMode: boolean;
  /** Item da 2ª metade. */
  halfId: string | null;
  options: Record<string, number>;
  quantity: number;
  note: string;
};

/** Corpo de POST /api/public/menu/:slug/price (PriceRequest da API). */
export type PriceRequest = { itemId: string; sizeId: string | null; halves: string[]; optionIds: string[]; quantity: number };

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
  baseCents: number;
  options: { id: string; groupId: string; name: string; priceCents: number }[];
  optionsCents: number;
  unitCents: number;
  quantity: number;
  totalCents: number;
};

export type AddButton = { disabled: true; label: string; code: PricingErrorCode } | { disabled: false; label: string; totalCents: number };

export type PriceResponse = { ok: true; line: PricedLine; button: AddButton } | { ok: false; errors: PricingError[]; button: AddButton };

export type HalfRule = "MAX" | "AVERAGE" | "SUM";

export const MAX_QUANTITY = 99;

export function emptySelection(item: PublicMenuItem): ItemSelection {
  // Com um tamanho só, ele já vem marcado; com vários, o cliente escolhe (R6: o botão diz "Escolha o tamanho").
  return { itemId: item.id, sizeId: item.sizes.length === 1 ? item.sizes[0]!.id : null, halfMode: false, halfId: null, options: {}, quantity: 1, note: "" };
}

export function priceRequestOf(selection: ItemSelection): PriceRequest {
  const optionIds = Object.entries(selection.options).flatMap(([id, count]) => Array.from({ length: Math.max(0, count) }, () => id));
  return {
    itemId: selection.itemId,
    sizeId: selection.sizeId,
    halves: selection.halfMode && selection.halfId ? [selection.halfId] : [],
    optionIds,
    quantity: selection.quantity,
  };
}

/** Chave estável do pedido de preço: a mesma escolha não pede o preço de novo. */
export function requestKey(request: PriceRequest): string {
  return JSON.stringify([request.itemId, request.sizeId, request.halves, [...request.optionIds].sort(), request.quantity]);
}

/** O que falta antes de perguntar o preço à API: sem isso o botão já sabe o que dizer. */
export function missingChoice(item: PublicMenuItem, selection: ItemSelection): "size" | "half" | null {
  if (item.sizes.length > 0 && !selection.sizeId) return "size";
  if (selection.halfMode && !selection.halfId) return "half";
  return null;
}

// ---------- Grupos de complementos ----------

type Group = PublicMenuItem["optionGroups"][number];

/** Como o grupo se escolhe: um (rádio), vários (caixa) ou quantidade por opção (combo "escolha 3"). */
export function groupKind(group: Group): "single" | "multi" | "count" {
  if (group.maxSelect <= 1) return "single";
  return group.minSelect === group.maxSelect ? "count" : "multi";
}

export function groupCount(group: Group, selection: ItemSelection): number {
  return group.options.reduce((sum, option) => sum + (selection.options[option.id] ?? 0), 0);
}

/** Selo do grupo: "Obrigatório", "Opcional · até 3" ou "Opcional". */
export function groupBadge(group: Group): string {
  if (group.minSelect > 0) return "Obrigatório";
  return group.maxSelect > 1 ? `Opcional · até ${group.maxSelect}` : "Opcional";
}

/** Linha de baixo do título: "Escolha 1", "Escolha 3", "2 de 3 escolhidos", "3 de 3 · completo". */
export function groupHint(group: Group, selection: ItemSelection): { text: string; complete: boolean } {
  const count = groupCount(group, selection);
  const complete = group.minSelect > 0 && count >= group.minSelect && count <= group.maxSelect;
  if (complete && group.maxSelect > 1) return { text: `${count} de ${group.maxSelect} · completo`, complete };
  if (group.maxSelect <= 1) return { text: "Escolha 1", complete };
  if (group.minSelect > 0 && group.minSelect === group.maxSelect) return { text: `${count} de ${group.maxSelect} · escolha ${group.maxSelect}`, complete };
  if (group.minSelect > 0) return { text: `${count} escolhidos · de ${group.minSelect} a ${group.maxSelect}`, complete };
  return { text: `${count} de ${group.maxSelect} escolhidos`, complete };
}

/** Mínimo e máximo de cada grupo, com o texto que aparece logo abaixo dele quando o cliente tenta avançar. */
export function groupErrors(item: PublicMenuItem, selection: ItemSelection): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const group of item.optionGroups) {
    const count = groupCount(group, selection);
    if (count < group.minSelect) errors[group.id] = group.minSelect === 1 ? `Escolha 1 opção em ${group.name}` : `Escolha ${group.minSelect} em ${group.name}`;
    else if (count > group.maxSelect) errors[group.id] = `Escolha até ${group.maxSelect} em ${group.name}`;
  }
  return errors;
}

/** Toque numa opção: rádio troca (e desmarca no 2º toque se o grupo for opcional), caixa liga e desliga até o máximo. */
export function toggleOption(group: Group, selection: ItemSelection, optionId: string): ItemSelection {
  const option = group.options.find((o) => o.id === optionId);
  if (!option || option.soldOut) return selection;
  const options = { ...selection.options };
  const on = (options[optionId] ?? 0) > 0;
  if (groupKind(group) === "single") {
    for (const o of group.options) delete options[o.id];
    if (!on || group.minSelect > 0) options[optionId] = 1;
  } else if (on) {
    delete options[optionId];
  } else if (groupCount(group, selection) < group.maxSelect) {
    options[optionId] = 1;
  } else {
    return selection;
  }
  return { ...selection, options };
}

/** Mais ou menos uma unidade da opção (combo), sem passar do máximo do grupo nem de zero. */
export function stepOption(group: Group, selection: ItemSelection, optionId: string, delta: 1 | -1): ItemSelection {
  const option = group.options.find((o) => o.id === optionId);
  if (!option) return selection;
  const current = selection.options[optionId] ?? 0;
  if (delta > 0 && (option.soldOut || groupCount(group, selection) >= group.maxSelect)) return selection;
  const next = Math.max(0, current + delta);
  const options = { ...selection.options };
  if (next === 0) delete options[optionId];
  else options[optionId] = next;
  return { ...selection, options };
}

// ---------- Meio a meio (R7) ----------

const sameName = (a: string, b: string) => a.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase() === b.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();

export function asHalfRule(value: string): HalfRule {
  return value === "MAX" || value === "AVERAGE" ? value : "SUM";
}

/** A regra do preço escrita no modal (R7). */
export function halfRuleText(rule: HalfRule): string {
  if (rule === "MAX") return "O preço é o da metade mais cara.";
  if (rule === "AVERAGE") return "O preço é a média das duas metades.";
  return "O preço é a soma das duas metades.";
}

/** Outros sabores da mesma categoria que aceitam meio a meio (os esgotados aparecem marcados, sem escolha). */
export function halfCandidates(item: PublicMenuItem, category: PublicMenuCategory | undefined): PublicMenuItem[] {
  if (!category?.allowsHalf || !item.allowsHalf) return [];
  return category.items.filter((other) => other.id !== item.id && other.allowsHalf);
}

/** Preço do sabor no tamanho escolhido (o mesmo nome de tamanho, como faz a API); null quando ele não tem esse tamanho. */
export function flavorPrice(flavor: PublicMenuItem, sizeName: string | null): number | null {
  if (flavor.sizes.length === 0) return flavor.priceCents;
  if (!sizeName) return Math.min(...flavor.sizes.map((s) => s.priceCents));
  return flavor.sizes.find((s) => sameName(s.name, sizeName))?.priceCents ?? null;
}

/** Se o sabor pode ser a 2ª metade agora (à venda e com o tamanho escolhido). */
export function flavorPickable(flavor: PublicMenuItem, sizeName: string | null): boolean {
  return orderable(flavor) && flavorPrice(flavor, sizeName) != null;
}

// ---------- Botão ----------

export type ButtonView = { label: string; tone: "ready" | "blocked"; totalCents: number | null };

/**
 * Texto do botão (R6: nunca "R$ 0,00"). Sem tamanho: "Escolha o tamanho"; sem a 2ª metade: "Escolha a 2ª metade";
 * com o preço da API: "Adicionar · R$ 62,80" (ou "Atualizar" ao editar); com erro da API, o motivo dela.
 * `response` é a última resposta válida (fica na tela enquanto a próxima carrega).
 */
export function buttonView(missing: "size" | "half" | null, response: PriceResponse | null, verb: "Adicionar" | "Atualizar"): ButtonView {
  if (missing === "size") return { label: "Escolha o tamanho", tone: "blocked", totalCents: null };
  if (missing === "half") return { label: "Escolha a 2ª metade", tone: "blocked", totalCents: null };
  if (!response) return { label: verb, tone: "blocked", totalCents: null };
  if (response.ok) return { label: `${verb} · ${money(response.line.totalCents)}`, tone: "ready", totalCents: response.line.totalCents };
  const label = response.button.disabled && response.button.code === "SIZE_REQUIRED" ? "Escolha o tamanho" : response.errors[0]?.message.replace(/\.$/, "") ?? verb;
  return { label, tone: "blocked", totalCents: null };
}

/** Pergunta o preço à API (mesma origem: o Next repassa /api para a API). */
export async function fetchPrice(slug: string, request: PriceRequest, signal?: AbortSignal): Promise<PriceResponse> {
  const response = await fetch(`/api/public/menu/${encodeURIComponent(slug)}/price`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw new Error(`Preço indisponível (${response.status})`);
  return (await response.json()) as PriceResponse;
}
