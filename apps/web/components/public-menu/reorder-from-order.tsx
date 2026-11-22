"use client";

import { useEffect, useState } from "react";
import { useCart } from "@/lib/public-cart";
import type { PublicMenuCategory } from "@/lib/public-menu";
import { fetchOrder, orderToken } from "@/lib/public-order";
import { reorderLines } from "@/lib/reorder";

export const REORDER_PARAM = "pedir-de-novo";

/**
 * Abre o cardápio com `?pedir-de-novo=<pedido>`: põe na sacola as escolhas daquele pedido (com o acesso deste
 * navegador ou da sessão do código) e avisa o que ficou de fora. Tira o parâmetro da barra para não repetir.
 */
export function ReorderFromOrder({ slug, categories }: { slug: string; categories: PublicMenuCategory[] }) {
  const cart = useCart();
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const orderId = url.searchParams.get(REORDER_PARAM);
    if (!orderId) return;
    url.searchParams.delete(REORDER_PARAM);
    window.history.replaceState(null, "", url.toString());
    fetchOrder(slug, orderId, orderToken(orderId))
      .then((order) => {
        if (!order) return setNotice("Não conseguimos abrir aquele pedido neste celular.");
        if (!order.reorder?.length) return setNotice("Este pedido é anterior ao \"Pedir de novo\". Monte a sacola pelo cardápio.");
        const { lines, skipped } = reorderLines(categories, order.reorder);
        lines.forEach(cart.add);
        setNotice(
          lines.length === 0
            ? "Os itens daquele pedido não estão disponíveis agora."
            : skipped > 0
              ? `Pusemos ${lines.length} ${lines.length === 1 ? "item" : "itens"} na sacola. ${skipped} não ${skipped === 1 ? "está disponível" : "estão disponíveis"} agora.`
              : "Pusemos os itens do pedido na sacola. Confira os preços antes de continuar.",
        );
      })
      .catch(() => setNotice("Não conseguimos abrir aquele pedido. Tente de novo."));
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
