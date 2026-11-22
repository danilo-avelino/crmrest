// Sacola do cardápio público: linhas guardadas no navegador, uma sacola por loja (localStorage por slug).
// A ficha do item (F3-04) adiciona e atualiza; a tela da sacola (F3-06) monta a interface em cima deste estado.
// O preço da linha é o retrato que a API devolveu ao adicionar; o checkout confere de novo no servidor.

import { createContext, createElement, type ReactNode, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { ItemSelection, PricedLine } from "./item-sheet";

export type CartLine = {
  /** Id da linha (o mesmo item pode entrar duas vezes com escolhas diferentes). */
  id: string;
  itemId: string;
  name: string;
  sizeId: string | null;
  sizeName: string | null;
  /** 2ª metade do meio a meio. */
  half: { id: string; name: string } | null;
  /** Unidades de cada complemento, como na ficha. */
  options: Record<string, number>;
  /** Nomes e preços dos complementos, para a sacola mostrar as opções em linha. */
  optionLines: { id: string; name: string; priceCents: number }[];
  quantity: number;
  note: string | null;
  unitCents: number;
  totalCents: number;
  /** Quando a API deu o preço (ms). */
  pricedAt: number;
};

export const storageKey = (slug: string) => `dishdesk:cart:${slug}`;

const VERSION = 1;

/** Lê a sacola salva; vazia se não houver, se o navegador bloquear o armazenamento ou se o formato for outro. */
export function loadCart(slug: string, storage: Pick<Storage, "getItem"> | undefined = safeStorage()): CartLine[] {
  try {
    const raw = storage?.getItem(storageKey(slug));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { v?: number; lines?: unknown };
    return parsed.v === VERSION && Array.isArray(parsed.lines) ? (parsed.lines as CartLine[]) : [];
  } catch {
    return [];
  }
}

export function saveCart(slug: string, lines: CartLine[], storage: Pick<Storage, "setItem" | "removeItem"> | undefined = safeStorage()): void {
  try {
    if (lines.length === 0) storage?.removeItem(storageKey(slug));
    else storage?.setItem(storageKey(slug), JSON.stringify({ v: VERSION, lines }));
  } catch {
    // Navegador sem armazenamento (aba anônima, bloqueio): a sacola vale só até fechar a página.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Monta a linha a partir da escolha e do preço que a API devolveu. */
export function lineOf(
  input: { id?: string; name: string; sizeName: string | null; halfName: string | null; selection: ItemSelection; priced: PricedLine },
  now = Date.now(),
): CartLine {
  const { selection, priced } = input;
  return {
    id: input.id ?? newLineId(),
    itemId: priced.itemId,
    name: input.name,
    sizeId: priced.sizeId,
    sizeName: input.sizeName,
    half: selection.halfMode && selection.halfId ? { id: selection.halfId, name: input.halfName ?? "" } : null,
    options: { ...selection.options },
    optionLines: priced.options.map(({ id, name, priceCents }) => ({ id, name, priceCents })),
    quantity: priced.quantity,
    note: selection.note.trim() || null,
    unitCents: priced.unitCents,
    totalCents: priced.totalCents,
    pricedAt: now,
  };
}

/** Escolha da ficha a partir de uma linha da sacola (variante "Editar item"). */
export function selectionOfLine(line: CartLine): ItemSelection {
  return {
    itemId: line.itemId,
    sizeId: line.sizeId,
    halfMode: line.half != null,
    halfId: line.half?.id ?? null,
    options: { ...line.options },
    quantity: line.quantity,
    note: line.note ?? "",
  };
}

export function newLineId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export const addLine = (lines: CartLine[], line: CartLine): CartLine[] => [...lines, line];

/** Troca a linha de mesmo id; se ela saiu da sacola nesse meio tempo, entra de novo. */
export const updateLine = (lines: CartLine[], line: CartLine): CartLine[] =>
  lines.some((l) => l.id === line.id) ? lines.map((l) => (l.id === line.id ? line : l)) : [...lines, line];

export const removeLine = (lines: CartLine[], id: string): CartLine[] => lines.filter((l) => l.id !== id);

export function cartSummary(lines: CartLine[]): { count: number; subtotalCents: number } {
  return {
    count: lines.reduce((sum, l) => sum + l.quantity, 0),
    subtotalCents: lines.reduce((sum, l) => sum + l.totalCents, 0),
  };
}

// ---------- React ----------

export type Cart = {
  slug: string;
  lines: CartLine[];
  add: (line: CartLine) => void;
  update: (line: CartLine) => void;
  remove: (id: string) => void;
  clear: () => void;
};

const CartContext = createContext<Cart | null>(null);

// Uma sacola por slug na memória, lida do localStorage na primeira vez; quem usa assina as mudanças.
const carts = new Map<string, CartLine[]>();
const listeners = new Set<() => void>();
const EMPTY: CartLine[] = [];

function snapshot(slug: string): CartLine[] {
  let lines = carts.get(slug);
  if (!lines) {
    lines = loadCart(slug);
    carts.set(slug, lines);
  }
  return lines;
}

function commit(slug: string, change: (lines: CartLine[]) => CartLine[]): void {
  const lines = change(snapshot(slug));
  carts.set(slug, lines);
  saveCart(slug, lines);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Esquece a sacola em memória (testes). */
export function resetCartMemory(): void {
  carts.clear();
}

export function CartProvider({ slug, children }: { slug: string; children?: ReactNode }) {
  // No servidor (ISR) a sacola é vazia; no navegador vem do localStorage, sem erro de hidratação.
  const lines = useSyncExternalStore(
    subscribe,
    () => snapshot(slug),
    () => EMPTY,
  );
  const add = useCallback((line: CartLine) => commit(slug, (current) => addLine(current, line)), [slug]);
  const update = useCallback((line: CartLine) => commit(slug, (current) => updateLine(current, line)), [slug]);
  const remove = useCallback((id: string) => commit(slug, (current) => removeLine(current, id)), [slug]);
  const clear = useCallback(() => commit(slug, () => []), [slug]);
  const value = useMemo(() => ({ slug, lines, add, update, remove, clear }), [slug, lines, add, update, remove, clear]);
  return createElement(CartContext.Provider, { value }, children);
}

export function useCart(): Cart {
  const cart = useContext(CartContext);
  if (!cart) throw new Error("useCart fora do CartProvider");
  return cart;
}
