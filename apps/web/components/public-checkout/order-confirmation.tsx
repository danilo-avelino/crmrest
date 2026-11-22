"use client";

import { ChevronLeftIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { storeContactLink } from "@/lib/public-checkout";
import { money } from "@/lib/public-menu";
import { confirmationHead, fetchOrder, orderToken, paymentLine, type PublicOrder } from "@/lib/public-order";
import { REORDER_PARAM } from "@/components/public-menu/reorder-from-order";
import { NotifyButton, notifyStatus, OrderRating, OrderTimeline } from "./order-tracking";

const STATUS: Record<string, { label: string; className: string }> = {
  PLACED: { label: "Recebido", className: "bg-warning-lt text-warning-ink" },
  CONFIRMED: { label: "Confirmado", className: "bg-success-lt text-success-ink" },
  PREPARING: { label: "Em preparo", className: "bg-warning-lt text-warning-ink" },
  READY: { label: "Pronto", className: "bg-success-lt text-success-ink" },
  DISPATCHED: { label: "Saiu para entrega", className: "bg-[#E8EEF8] text-[#2B3A67]" },
  DELIVERED: { label: "Entregue", className: "bg-success-lt text-success-ink" },
  CANCELED: { label: "Cancelado", className: "bg-tomate-lt text-[#9C2914]" },
};

const card = "rounded-lg border border-rule bg-surface p-3";
const FINAL = new Set(["DELIVERED", "CANCELED"]);

/** Pedido confirmado (W15 mínimo). Abre pelo token guardado neste navegador ou pela sessão do código. */
export function OrderConfirmation({ slug, orderId, storeName }: { slug: string; orderId: string; storeName: string }) {
  const menuHref = `/c/${encodeURIComponent(slug)}`;
  const [order, setOrder] = useState<PublicOrder | null | "loading" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchOrder(slug, orderId, orderToken(orderId))
      .then((found) => alive && setOrder(found))
      .catch(() => alive && setOrder("error"));
    return () => {
      alive = false;
    };
  }, [slug, orderId, attempt]);

  // Acompanhamento: confere o pedido a cada 30 s até ele ser entregue ou cancelado; avisa a mudança se o cliente permitiu.
  const liveStatus = typeof order === "object" && order ? order.status : null;
  useEffect(() => {
    if (!liveStatus || FINAL.has(liveStatus)) return;
    const timer = setInterval(() => {
      fetchOrder(slug, orderId, orderToken(orderId))
        .then((found) => {
          if (!found) return;
          if (found.status !== liveStatus) notifyStatus(found.status);
          setOrder(found);
        })
        .catch(() => {});
    }, 30_000);
    return () => clearInterval(timer);
  }, [slug, orderId, liveStatus]);

  const header = (title: string) => (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-1 border-b border-rule bg-surface px-2">
      <Link href={menuHref} aria-label="Voltar ao cardápio" className="flex size-11 items-center justify-center rounded-lg text-ink hover:bg-surface-2">
        <ChevronLeftIcon className="size-[18px]" aria-hidden />
      </Link>
      <h1 className="m-0 font-heading text-title font-semibold">{title}</h1>
      <span className="ml-auto pr-2 text-ink-3">{storeName}</span>
    </header>
  );

  if (order === "loading") {
    return (
      <div className="mx-auto w-full max-w-xl">
        {header("Pedido")}
        <div className="flex flex-col gap-3 p-3" aria-label="Carregando" aria-busy>
          <div className="h-28 animate-pulse rounded-lg bg-surface-2" />
          <div className="h-40 animate-pulse rounded-lg bg-surface-2" />
        </div>
      </div>
    );
  }
  if (order === "error" || order === null) {
    return (
      <div className="mx-auto w-full max-w-xl">
        {header("Pedido")}
        <div role="alert" className="flex flex-col items-center gap-3 px-4 py-16 text-center">
          <p className="m-0 font-medium">{order === null ? "Não achamos este pedido neste celular." : "Não conseguimos abrir o pedido."}</p>
          {order === null ? (
            <p className="m-0 text-ink-2">Abra pelo mesmo celular em que fez o pedido ou entre com o código do WhatsApp.</p>
          ) : (
            <Button variant="outline" onClick={() => (setOrder("loading"), setAttempt((n) => n + 1))}>
              Tentar de novo
            </Button>
          )}
          <Link href={menuHref} className="font-medium underline">
            Voltar ao cardápio
          </Link>
        </div>
      </div>
    );
  }

  const head = confirmationHead(order, new Date());
  const status = STATUS[order.status] ?? STATUS.CONFIRMED!;
  const contact = storeContactLink(order.storePhone);
  return (
    <div className="mx-auto w-full max-w-xl">
      {header(`Pedido #${order.code}`)}
      <div className="flex flex-col gap-3 px-3 py-4">
        <div className={`${card} flex flex-col gap-1 p-4`}>
          <span className={`self-start rounded-full px-2 py-0.5 text-[11px] font-semibold ${status.className}`}>{status.label}</span>
          <div className="mt-1 text-ink-2">{head.label}</div>
          <div className="font-heading text-display leading-tight font-bold tracking-[-0.5px] tabular-nums">{head.value}</div>
          <div className="mt-1 text-ink-2">A loja recebeu seu pedido. O pagamento é {order.mode === "PICKUP" ? "na retirada" : "na entrega"}.</div>
        </div>

        <OrderTimeline order={order} />

        {order.status === "DELIVERED" && <OrderRating slug={slug} order={order} onRated={(rating) => setOrder({ ...order, rating })} />}

        {(order.reorder?.length ?? 0) > 0 && (
          <Link href={`${menuHref}?${REORDER_PARAM}=${encodeURIComponent(order.id)}`} className="flex h-12 items-center justify-center rounded-md bg-ink font-medium text-paper no-underline">
            Pedir de novo
          </Link>
        )}

        {!FINAL.has(order.status) && <NotifyButton />}

        {contact && (
          <a href={contact} target="_blank" rel="noreferrer" className="flex h-12 items-center justify-center gap-2 rounded-md border border-rule bg-surface font-medium text-ink no-underline">
            <span className="size-2 rounded-full bg-whatsapp" aria-hidden />
            Falar com a loja pelo WhatsApp
          </a>
        )}

        <div className={`${card} flex flex-col gap-1.5`}>
          <div className="font-semibold">Resumo</div>
          {order.items.map((item, i) => (
            <div key={`${item.name}-${i}`}>
              <div className="flex justify-between gap-3">
                <span>
                  {item.quantity}× {item.name}
                </span>
                <span className="tabular-nums">{money(item.totalCents)}</span>
              </div>
              {(item.options.length > 0 || item.notes) && (
                <div className="text-[12px] text-ink-3">{[...item.options, item.notes].filter(Boolean).join(" · ")}</div>
              )}
            </div>
          ))}
          {order.mode === "DELIVERY" && (
            <div className="flex justify-between text-ink-2">
              <span>Entrega</span>
              <span className="tabular-nums">{order.deliveryFeeCents === 0 ? "Grátis" : money(order.deliveryFeeCents)}</span>
            </div>
          )}
          {order.benefit && order.benefit.discountCents > 0 && (
            <div className="flex justify-between text-success-ink">
              <span>{order.benefit.label}</span>
              <span className="tabular-nums">− {money(order.benefit.discountCents)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-[#EEE9E2] pt-1.5 font-semibold">
            <span>Total · {paymentLine(order)}</span>
            <span className="tabular-nums">{money(order.totalCents)}</span>
          </div>
          {order.notes && <div className="text-[12px] text-ink-3">Observação: {order.notes}</div>}
        </div>

        <div className={card}>
          <div className="font-semibold">{order.mode === "PICKUP" ? "Retirada" : "Entrega"}</div>
          <div className="text-ink-2">{order.mode === "PICKUP" ? `Retire em ${storeName}` : order.address}</div>
        </div>
      </div>
    </div>
  );
}
