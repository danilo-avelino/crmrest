// Sacola do cardápio público (F3-06): contas e regras da tela, sem React, para testar sozinho.
// Preço sempre da API: a sacola guarda o retrato do preço e confere de novo (POST /price) quando abre.

import { type PriceResponse, priceRequestOf, type PricingErrorCode, requestKey } from "./item-sheet";
import { type CartLine, selectionOfLine } from "./public-cart";
import { fold, moneyShort, orderable, type PublicMenuCategory, type PublicMenuItem, type PublicMenuStore } from "./public-menu";

export type BagStore = Pick<PublicMenuStore, "status" | "nextOpening" | "schedulingEnabled" | "feeRange" | "freeDeliveryFromCents" | "minOrderCents">;

export const subtotalOf = (lines: Pick<CartLine, "totalCents">[]): number => lines.reduce((sum, l) => sum + l.totalCents, 0);

/** "2 itens" / "1 item": soma das quantidades. */
export function itemsLabel(lines: Pick<CartLine, "quantity">[]): string {
  const count = lines.reduce((sum, l) => sum + l.quantity, 0);
  return `${count} ${count === 1 ? "item" : "itens"}`;
}

/** Quanto falta para a entrega grátis (R11): null sem regra de entrega grátis, 0 quando já chegou. */
export function freeDeliveryRemaining(subtotalCents: number, freeFromCents: number | null): number | null {
  if (freeFromCents == null) return null;
  return Math.max(0, freeFromCents - subtotalCents);
}

/** Progresso da barra, de 0 a 1. */
export function freeDeliveryProgress(subtotalCents: number, freeFromCents: number | null): number {
  if (freeFromCents == null || freeFromCents <= 0) return 0;
  return Math.min(1, subtotalCents / freeFromCents);
}

/** Quanto falta para o pedido mínimo (0 quando já atingiu ou não há mínimo). */
export const minOrderMissing = (subtotalCents: number, minOrderCents: number): number => Math.max(0, minOrderCents - subtotalCents);

/** Linha "Entrega" dos totais: grátis, faixa de taxa ou "a calcular" (o endereço só vem no checkout). */
export function deliveryLine(store: Pick<BagStore, "feeRange" | "freeDeliveryFromCents">, subtotalCents: number): string {
  if (store.freeDeliveryFromCents != null && subtotalCents >= store.freeDeliveryFromCents) return "Grátis";
  const range = store.feeRange;
  if (!range) return "a calcular";
  return range.minCents === range.maxCents ? moneyShort(range.minCents) : `${moneyShort(range.minCents)} a ${moneyShort(range.maxCents)}`;
}

/** "18:00" de "hoje às 18:00"; null se o texto não tiver hora. */
export const openingTime = (nextOpening: string | null): string | null => nextOpening?.match(/\d{1,2}:\d{2}/)?.[0] ?? null;

export type BagButton = {
  /** O que o botão faz; null quando não há botão (sacola vazia, loja pausada ou fechada sem agendamento). */
  action: "continue" | "schedule" | null;
  label: string;
  disabled: boolean;
  /** Explicação que fica junto do botão. */
  message: string | null;
};

/** Botão principal da sacola: loja aberta continua, fechada agenda (R2, nunca botão morto), pausada só avisa. */
export function bagButton(store: BagStore, input: { subtotalCents: number; count: number; unavailable: number }): BagButton {
  if (input.count === 0) return { action: null, label: "", disabled: true, message: null };
  if (store.status === "paused") return { action: null, label: "", disabled: true, message: "A loja pausou os pedidos por enquanto. Sua sacola fica guardada." };
  const closed = store.status === "closed";
  if (closed && !store.schedulingEnabled) {
    return { action: null, label: "", disabled: true, message: `A loja está fechada${store.nextOpening ? `. Abre ${store.nextOpening}` : ""}. Sua sacola fica guardada.` };
  }
  const time = openingTime(store.nextOpening);
  const action = closed ? "schedule" : "continue";
  const label = closed ? (time ? `Agendar para as ${time}` : "Agendar pedido") : "Continuar";
  const missing = minOrderMissing(input.subtotalCents, store.minOrderCents);
  if (missing > 0) return { action, label, disabled: true, message: `Faltam ${moneyShort(missing)} para o pedido mínimo de ${moneyShort(store.minOrderCents)}.` };
  if (input.unavailable > 0) {
    return { action, label, disabled: true, message: input.unavailable === 1 ? "Troque ou remova o item indisponível para continuar." : "Troque ou remova os itens indisponíveis para continuar." };
  }
  return { action, label, disabled: false, message: closed ? "A loja está fechada: o pedido sai no horário agendado." : null };
}

// ---------- Conferência de preço ao abrir a sacola ----------

export type LineCheck = { kind: "ok" } | { kind: "changed"; fromCents: number; toCents: number } | { kind: "unavailable"; message: string };

const UNAVAILABLE: PricingErrorCode[] = ["ITEM_NOT_FOUND", "ITEM_UNAVAILABLE", "OPTION_NOT_FOUND", "OPTION_UNAVAILABLE", "SIZE_NOT_FOUND"];

/** Pedido de preço da linha (mesma conta da ficha). */
export const requestOfLine = (line: CartLine) => priceRequestOf(selectionOfLine(line));

/** Chave que muda quando a escolha da linha muda: a mesma escolha não é conferida duas vezes. */
export const checkKey = (line: CartLine): string => `${line.id}:${requestKey(requestOfLine(line))}`;

/** Compara a resposta atual da API com o preço guardado na linha. Preço novo vale (o checkout confere de novo). */
export function reconcileLine(line: CartLine, response: PriceResponse): { check: LineCheck; unitCents?: number; totalCents?: number } {
  if (!response.ok) {
    const gone = response.errors.some((e) => UNAVAILABLE.includes(e.code));
    return { check: { kind: "unavailable", message: gone ? "Esgotou ou saiu do cardápio" : "Esta escolha não está mais disponível" } };
  }
  const { unitCents, totalCents } = response.line;
  if (totalCents === line.totalCents) return { check: { kind: "ok" } };
  return { check: { kind: "changed", fromCents: line.totalCents, toCents: totalCents }, unitCents, totalCents };
}

/** Item que saiu do ar depois de entrar na sacola, pelo cardápio carregado (antes de a API responder). */
export function lineGone(line: CartLine, items: Map<string, PublicMenuItem>): boolean {
  const item = items.get(line.itemId);
  return !item || !orderable(item);
}


// ---------- Peça também ----------

const PAIRING_CATEGORY = /bebida|sobremesa|refri|suco|doce/;

/** Preço de referência do item (o menor tamanho quando há tamanhos). */
export function referenceCents(item: Pick<PublicMenuItem, "priceCents" | "sizes">): number | null {
  if (item.sizes.length > 0) return Math.min(...item.sizes.map((s) => s.priceCents));
  return item.priceCents;
}

/**
 * "Peça também": itens de categorias de bebida/sobremesa, ou os destaques se o cardápio não tiver essas categorias.
 * SEAM: a API pública ainda não expõe `pairsWith`; quando expuser, entra aqui antes das categorias.
 * Com entrega grátis a completar, os que fecham o valor vêm primeiro.
 */
export function suggestionsOf(
  categories: PublicMenuCategory[],
  highlights: PublicMenuItem[],
  lines: Pick<CartLine, "itemId">[],
  remainingCents: number | null,
  limit = 6,
): { item: PublicMenuItem; completes: boolean }[] {
  const inBag = new Set(lines.map((l) => l.itemId));
  const fromCategories = categories.filter((c) => PAIRING_CATEGORY.test(fold(c.name))).flatMap((c) => c.items);
  const pool = (fromCategories.length > 0 ? fromCategories : highlights).filter((i) => orderable(i) && !inBag.has(i.id) && referenceCents(i) != null);
  const marked = pool.map((item) => ({ item, completes: remainingCents != null && remainingCents > 0 && referenceCents(item)! >= remainingCents }));
  return [...marked.filter((m) => m.completes), ...marked.filter((m) => !m.completes)].slice(0, limit);
}
