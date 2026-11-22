"use client";

import { ChevronLeftIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { REORDER_PARAM } from "@/components/public-menu/reorder-from-order";
import { Button } from "@/components/ui/button";
import { usePendingAction } from "@/hooks/use-pending-action";
import { fetchMe, logout, type Me } from "@/lib/public-checkout";
import { money } from "@/lib/public-menu";
import { IdentifyStep } from "./identify-step";

type OrderRow = { id: string; code: string | null; status: string; totalCents: number; placedAt: string; fromMenu: boolean; summary: string };
type Page = { orders: OrderRow[]; hasMore: boolean };

const STATUS_LABEL: Record<string, string> = {
  PLACED: "Recebido",
  CONFIRMED: "Confirmado",
  PREPARING: "Em preparo",
  READY: "Pronto",
  DISPATCHED: "Saiu para entrega",
  DELIVERED: "Entregue",
  CANCELED: "Cancelado",
};

async function fetchOrders(slug: string, before?: string): Promise<Page | null> {
  const query = before ? `?before=${encodeURIComponent(before)}` : "";
  const response = await fetch(`/api/public/menu/${encodeURIComponent(slug)}/me/orders${query}`, { credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Pedidos indisponíveis (${response.status})`);
  return (await response.json()) as Page;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });

/**
 * Minha conta (W16) e Pedidos sem identificação (W17). Sem o código, explica e oferece entrar (sem pedir permissão de
 * notificação, R16). Com o código: pedidos paginados com "Pedir de novo", endereços salvos e "Sair" com confirmação.
 */
export function MyAccount({ slug, storeName }: { slug: string; storeName: string }) {
  const menuHref = `/c/${encodeURIComponent(slug)}`;
  const [me, setMe] = useState<Me | null | "loading" | "error">("loading");
  const [page, setPage] = useState<Page>({ orders: [], hasMore: false });
  const [identifying, setIdentifying] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  const load = useCallback(async () => {
    try {
      const found = await fetchMe(slug);
      setMe(found);
      if (found) setPage((await fetchOrders(slug)) ?? { orders: [], hasMore: false });
    } catch {
      setMe("error");
    }
  }, [slug]);

  // Convite do cardápio: sem sessão, já abre a entrada pelo código.
  useEffect(() => {
    // Abre a entrada logo depois de saber que não há sessão (no navegador: lê a barra de endereço).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (me === null && new URLSearchParams(window.location.search).has("voltar")) setIdentifying(true);
  }, [me]);

  useEffect(() => {
    // Só ao abrir: a sessão está no cookie desta loja.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const [more, loadingMore] = usePendingAction(async () => {
    const last = page.orders.at(-1)?.placedAt;
    const next = await fetchOrders(slug, last);
    if (next) setPage({ orders: [...page.orders, ...next.orders], hasMore: next.hasMore });
  });
  const [leave, leaving] = usePendingAction(async () => {
    await logout(slug);
    setConfirmLogout(false);
    setMe(null);
    setPage({ orders: [], hasMore: false });
  });

  const header = (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-1 border-b border-rule bg-surface px-2">
      <Link href={menuHref} aria-label="Voltar ao cardápio" className="flex size-11 items-center justify-center rounded-lg text-ink hover:bg-surface-2">
        <ChevronLeftIcon className="size-[18px]" aria-hidden />
      </Link>
      <h1 className="m-0 font-heading text-title font-semibold">Minha conta</h1>
      <span className="ml-auto pr-2 text-ink-3">{storeName}</span>
    </header>
  );

  if (identifying) {
    return (
      <IdentifyStep
        slug={slug}
        storeName={storeName}
        initialPhone=""
        backHref={`${menuHref}/conta`}
        onVerified={async () => {
          // Veio do convite do cardápio ("Faça o login para ver cupons"): volta para ele.
          if (new URLSearchParams(window.location.search).has("voltar")) {
            window.location.assign(new URL(menuHref, window.location.origin).toString());
            return;
          }
          setIdentifying(false);
          setMe("loading");
          await load();
        }}
        onGuest={() => setIdentifying(false)}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl">
      {header}
      <div className="flex flex-col gap-3 px-3 py-4">
        {me === "loading" && <div className="h-40 animate-pulse rounded-lg bg-surface-2" aria-busy aria-label="Carregando" />}
        {me === "error" && (
          <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="m-0 font-medium">Não conseguimos abrir sua conta.</p>
            <Button variant="outline" onClick={() => (setMe("loading"), void load())}>
              Tentar de novo
            </Button>
          </div>
        )}
        {me === null && (
          <div className="flex flex-col gap-3 rounded-lg border border-rule bg-surface p-5 text-center">
            <p className="m-0 font-heading text-title font-semibold">Seus pedidos ficam guardados aqui</p>
            <p className="m-0 text-ink-2">Para ver seus pedidos e endereços, entre com o código que enviamos pelo WhatsApp. Só quem tem o celular consegue entrar.</p>
            <Button onClick={() => setIdentifying(true)}>Entrar com o código</Button>
            <Link href={menuHref} className="font-medium underline">
              Voltar ao cardápio
            </Link>
          </div>
        )}
        {typeof me === "object" && me && (
          <>
            <div className="rounded-lg border border-rule bg-surface p-4">
              <p className="m-0 font-medium">{me.name ?? "Cliente"}</p>
              <p className="m-0 text-ink-2 tabular-nums">{me.phone}</p>
            </div>

            <section className="flex flex-col gap-2">
              <h2 className="m-0 font-heading text-title font-semibold">Pedidos</h2>
              {page.orders.length === 0 && <p className="m-0 text-ink-2">Nenhum pedido ainda.</p>}
              {page.orders.map((order) => (
                <div key={order.id} className="flex flex-col gap-1.5 rounded-lg border border-rule bg-surface p-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">
                      {order.code ? `#${order.code}` : "Pedido"} · {day(order.placedAt)}
                    </span>
                    <span className="tabular-nums">{money(order.totalCents)}</span>
                  </div>
                  <span className="text-[12.5px] text-ink-2">{order.summary}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-[12px] text-ink-3">{STATUS_LABEL[order.status] ?? order.status}</span>
                    {order.fromMenu && (
                      <>
                        <Link href={`${menuHref}/pedido/${order.id}`} className="ml-auto text-[13px] font-medium underline">
                          Ver
                        </Link>
                        <Link href={`${menuHref}?${REORDER_PARAM}=${encodeURIComponent(order.id)}`} className="text-[13px] font-medium underline">
                          Pedir de novo
                        </Link>
                      </>
                    )}
                  </div>
                </div>
              ))}
              {page.hasMore && (
                <Button variant="outline" onClick={more} loading={loadingMore}>
                  Ver mais pedidos
                </Button>
              )}
            </section>

            <section className="flex flex-col gap-2">
              <h2 className="m-0 font-heading text-title font-semibold">Endereços</h2>
              {me.addresses.length === 0 && <p className="m-0 text-ink-2">Os endereços dos seus pedidos aparecem aqui.</p>}
              {me.addresses.map((address) => (
                <div key={address.id} className="rounded-lg border border-rule bg-surface p-3">
                  <p className="m-0 font-medium">{address.label ?? address.street}</p>
                  <p className="m-0 text-[12.5px] text-ink-2">
                    {[address.number ? `${address.street}, ${address.number}` : address.street, address.complement, address.district].filter(Boolean).join(" · ")}
                  </p>
                </div>
              ))}
            </section>

            {confirmLogout ? (
              <div className="flex flex-col gap-2 rounded-lg border border-rule bg-surface p-3">
                <p className="m-0">Sair da conta neste celular?</p>
                <div className="flex gap-2">
                  <Button variant="destructive" onClick={leave} loading={leaving}>
                    Sair
                  </Button>
                  <Button variant="outline" onClick={() => setConfirmLogout(false)} disabled={leaving}>
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmLogout(true)}>
                Sair da conta
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
