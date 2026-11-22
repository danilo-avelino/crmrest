"use client";

import { useEffect, useState } from "react";
import { CONTEXT_PARAM, fetchContext, saveContextToken } from "@/lib/menu-context";
import { useCart } from "@/lib/public-cart";
import type { PublicMenuCategory } from "@/lib/public-menu";
import { reorderLines } from "@/lib/reorder";

/**
 * Abre o cardápio com `?c=<token>` (link do WhatsApp, F3-11): a sacola passa a ser a da conversa, com os nomes e preços
 * de agora (a sacola confere cada linha na API). Tira o parâmetro da barra para não repetir.
 */
export function ContextFromChat({ slug, categories }: { slug: string; categories: PublicMenuCategory[] }) {
  const cart = useCart();
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const token = url.searchParams.get(CONTEXT_PARAM);
    if (!token) return;
    url.searchParams.delete(CONTEXT_PARAM);
    window.history.replaceState(null, "", url.toString());
    fetchContext(slug, token)
      .then((selections) => {
        if (!selections) return setNotice("Este link venceu ou o pedido já foi feito. Monte a sacola pelo cardápio.");
        saveContextToken(slug, token);
        if (selections.length === 0) return;
        const { lines, skipped } = reorderLines(categories, selections);
        cart.clear();
        lines.forEach(cart.add);
        setNotice(
          lines.length === 0
            ? "Os itens da conversa não estão disponíveis agora."
            : skipped > 0
              ? `Abrimos a sacola da sua conversa no WhatsApp. ${skipped} ${skipped === 1 ? "item não está disponível" : "itens não estão disponíveis"} agora.`
              : "Abrimos a sacola da sua conversa no WhatsApp. Confira e finalize por aqui.",
        );
      })
      .catch(() => setNotice("Não conseguimos abrir a sacola da conversa. Tente de novo."));
    // Só ao abrir a página.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!notice) return null;
  return (
    <div role="status" className="fixed inset-x-4 top-4 z-50 mx-auto flex max-w-md items-start gap-3 rounded-xl border border-rule bg-surface px-4 py-3 shadow-lg">
      <p className="m-0 flex-1 text-[13px]">{notice}</p>
      <button type="button" className="text-[13px] font-medium underline" onClick={() => setNotice(null)}>
        Fechar
      </button>
    </div>
  );
}
