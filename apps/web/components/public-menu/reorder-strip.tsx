"use client";

import { RotateCcwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { money } from "@/lib/public-menu";
import { REORDER_PARAM } from "./reorder-from-order";

type OrderRow = { id: string; code: string | null; status: string; totalCents: number; placedAt: string; fromMenu: boolean; summary: string };

/**
 * "Peça novamente" no topo do cardápio (W1), só para quem entrou com o código: os últimos pedidos feitos pelo cardápio,
 * com um toque para pôr de novo na sacola. Sem sessão ou sem pedido, não aparece.
 */
export function ReorderStrip({ slug }: { slug: string }) {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  useEffect(() => {
    let alive = true;
    fetch(`/api/public/menu/${encodeURIComponent(slug)}/me/orders`, { credentials: "same-origin", cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<{ orders: OrderRow[] }>) : { orders: [] }))
      .then((page) => alive && setOrders(page.orders.filter((o) => o.fromMenu && o.status !== "CANCELED").slice(0, 6)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [slug]);

  if (orders.length === 0) return null;
  const menuHref = `/c/${encodeURIComponent(slug)}`;
  return (
    <section className="pt-4" aria-label="Peça novamente">
      <h2 className="m-0 mb-3 font-heading text-[22px] font-bold">Peça novamente</h2>
      <div className="-mr-4 flex gap-3 overflow-x-auto pr-4 pb-1 [scrollbar-width:none] lg:mr-0 lg:grid lg:grid-cols-3 lg:overflow-visible lg:pr-0 [&::-webkit-scrollbar]:hidden">
        {orders.map((order) => (
          <a
            key={order.id}
            href={`${menuHref}?${REORDER_PARAM}=${encodeURIComponent(order.id)}`}
            className="flex w-[260px] shrink-0 items-center gap-3 rounded-xl border border-rule bg-surface p-3 text-ink no-underline shadow-[0_1px_2px_rgba(26,24,20,.04)] hover:border-ink-3 lg:w-auto"
          >
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-[13px] font-medium">{order.summary}</span>
              <span className="mt-0.5 block text-[13px] text-ink-2 tabular-nums">{money(order.totalCents)}</span>
            </span>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-rule" aria-label="Pedir de novo">
              <RotateCcwIcon className="size-4" aria-hidden />
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}
