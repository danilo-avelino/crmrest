// Link com contexto (F3-11): o agente do WhatsApp manda o cardápio com `?c=<token>`, e a sacola do site abre com o
// carrinho da conversa. O token fica guardado até o pedido entrar: o pedido feito no site fecha o carrinho de lá.

import type { ReorderSelection } from "./reorder";

export const CONTEXT_PARAM = "c";

const key = (slug: string) => `dishdesk:context:${slug}`;

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** As escolhas do carrinho da conversa; null quando o link venceu ou o pedido já foi feito. */
export async function fetchContext(slug: string, token: string): Promise<ReorderSelection[] | null> {
  const response = await fetch(`/api/public/menu/${encodeURIComponent(slug)}/context?${new URLSearchParams({ c: token })}`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Link indisponível (${response.status})`);
  return ((await response.json()) as { lines: ReorderSelection[] }).lines;
}

export function saveContextToken(slug: string, token: string | null, store: Pick<Storage, "setItem" | "removeItem"> | undefined = storage()): void {
  try {
    if (token) store?.setItem(key(slug), token);
    else store?.removeItem(key(slug));
  } catch {
    // Sem armazenamento: o pedido entra do mesmo jeito; só o carrinho da conversa fica aberto.
  }
}

export function contextToken(slug: string, store: Pick<Storage, "getItem"> | undefined = storage()): string | null {
  try {
    return store?.getItem(key(slug)) ?? null;
  } catch {
    return null;
  }
}
