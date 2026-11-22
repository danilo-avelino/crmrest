"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { ErrorNote, loadError, Skeleton, WarnNote } from "@/components/menu/bits";
import { useTenantId } from "@/components/menu/use-menu";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/use-now";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";
import { count } from "@/lib/format";
import { money } from "@/lib/menu";

export type AbandonedCart = {
  id: string;
  conversationId: string;
  customerName: string | null;
  phone: string | null;
  stage: "building" | "awaiting_confirmation" | "pix_expired";
  items: string[];
  subtotalCents: number;
  updatedAt: string;
  windowOpen: boolean;
  recoverySentAt: string | null;
};

const STAGE: Record<AbandonedCart["stage"], { label: string; dot: string; pill: string }> = {
  pix_expired: { label: "Pix gerado, não pago", dot: "bg-tomate", pill: "bg-tomate-lt text-tomate-ink" },
  awaiting_confirmation: { label: "Parou no resumo", dot: "bg-warning", pill: "bg-warning-lt text-warning-ink" },
  building: { label: "Parou na sacola", dot: "bg-ink-3", pill: "bg-surface-2 text-ink-2" },
};

type Filter = "all" | "pix" | "bag";
const FILTERS: [Filter, string][] = [
  ["all", "Todos"],
  ["pix", "Pix não pago"],
  ["bag", "Sacola"],
];
const matches = (cart: AbandonedCart, filter: Filter) => filter === "all" || (filter === "pix" ? cart.stage === "pix_expired" : cart.stage !== "pix_expired");

/** "há 2 h", "há 3 dias". */
export function idleLabel(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  return `há ${days} ${days === 1 ? "dia" : "dias"}`;
}

/** "(11) 9••••-2210": o painel mostra o telefone mascarado na lista. */
export function maskedPhone(phone: string | null): string | null {
  const digits = phone?.replace(/\D/g, "").replace(/^55/, "") ?? "";
  if (digits.length < 10) return null;
  return `(${digits.slice(0, 2)}) ${digits[2]}••••-${digits.slice(-4)}`;
}

const clock = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

/**
 * Carrinhos e Pix abandonados (P7, F7-07): o que a IA montou no WhatsApp e não virou pedido. Um bloco só, como o board:
 * o número com o filtro dentro, e cada carrinho numa linha com a etapa, o tempo e a ação; fora da janela de 24 h, o
 * aviso colado na linha.
 */
export function AbandonedCarts() {
  const { request } = useAuth();
  const tenantId = useTenantId();
  const now = useNow(60_000);
  const [filter, setFilter] = useState<Filter>("all");
  const query = useQuery({
    queryKey: ["abandoned-carts", tenantId],
    queryFn: () => request<AbandonedCart[]>(`/menu/${tenantId}/abandoned-carts`),
    enabled: Boolean(tenantId),
    retry: false,
  });
  const header = (
    <div>
      <div className="text-xs text-ink-3">
        <Link href="/cardapio/funil" className="underline">
          Funil de vendas
        </Link>{" "}
        / Abandonados
      </div>
      <h1 className="m-0 font-heading text-display leading-tight font-bold tracking-[-0.5px]">Carrinhos e Pix abandonados</h1>
    </div>
  );

  if (query.isPending) {
    return (
      <div className="flex max-w-5xl flex-col gap-4 p-6">
        {header}
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="flex max-w-5xl flex-col gap-4 p-6">
        {header}
        <ErrorNote action={<Button variant="outline" size="sm" onClick={() => void query.refetch()}>Tentar de novo</Button>}>{loadError(query.error).text}</ErrorNote>
      </div>
    );
  }
  const carts = query.data;
  const shown = carts.filter((cart) => matches(cart, filter));
  const total = shown.reduce((sum, cart) => sum + cart.subtotalCents, 0);
  return (
    <div className="flex max-w-5xl flex-col gap-4 p-6">
      {header}
      <section className="overflow-hidden rounded-xl border border-rule bg-surface">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-rule px-5 py-4">
          <div>
            <p className="m-0 tabular-nums">
              <span className="font-heading text-[28px] font-bold">{count(shown.length)}</span>{" "}
              <span className="text-ink-2">
                {shown.length === 1 ? "carrinho abandonado" : "carrinhos abandonados"} · {money(total)} na mesa
              </span>
            </p>
            <p className="m-0 text-[12px] text-ink-3">Últimos 7 dias · montados pela IA no WhatsApp, parados há mais de 30 min</p>
          </div>
          <div className="inline-flex rounded-lg bg-surface-2 p-0.5" role="group" aria-label="Filtro">
            {FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={filter === value ? "h-8 rounded-md bg-surface px-3 text-[12.5px] font-semibold shadow-sm" : "h-8 rounded-md px-3 text-[12.5px] text-ink-2"}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="m-0 px-5 py-8 text-center text-ink-3">Nenhum carrinho parado agora.</p>
        ) : (
          <ul className="m-0 list-none p-0">
            {shown.map((cart) => (
              <CartRow key={cart.id} cart={cart} now={now} />
            ))}
          </ul>
        )}
      </section>
      <p className="m-0 text-[12px] text-ink-3">A sacola do site fica no celular do cliente e não aparece aqui.</p>
    </div>
  );
}

function CartRow({ cart, now }: { cart: AbandonedCart; now: number }) {
  const { request } = useAuth();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [send, sending] = usePendingAction(async () => {
    setError(null);
    try {
      await request(`/menu/${tenantId}/abandoned-carts/${cart.id}/recover`, { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: ["abandoned-carts", tenantId] });
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível mandar a mensagem.");
    }
  });
  const stage = STAGE[cart.stage];
  return (
    <li className="border-b border-rule-soft last:border-b-0">
      <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_6rem_11rem_4.5rem_12rem] items-center gap-x-4 px-5 py-3">
        <div className="min-w-0">
          <Link href={`/inbox?conversa=${cart.conversationId}`} className="block truncate font-medium text-ink no-underline hover:underline">
            {cart.customerName ?? "Cliente sem nome"}
          </Link>
          {maskedPhone(cart.phone) && <span className="block text-[12px] text-ink-3 tabular-nums">{maskedPhone(cart.phone)}</span>}
        </div>
        <span className="truncate text-[13px] text-ink-2">{cart.items.join(" · ")}</span>
        <span className="text-right font-semibold tabular-nums">{money(cart.subtotalCents)}</span>
        <span className={`inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-0.5 text-[11.5px] font-semibold ${stage.pill}`}>
          <span className={`size-1.5 rounded-full ${stage.dot}`} aria-hidden />
          {stage.label}
        </span>
        <span className="text-[12.5px] text-ink-3 tabular-nums">{idleLabel(cart.updatedAt, now).replace("há ", "")}</span>
        <span className="flex justify-end">
          {cart.recoverySentAt ? (
            <span role="status" className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-2">
              <span className="size-1.5 rounded-full bg-ink-3" aria-hidden />
              Enviada às {clock.format(new Date(cart.recoverySentAt))}
            </span>
          ) : cart.windowOpen ? (
            <Button size="sm" onClick={send} loading={sending}>
              Mandar mensagem de recuperação
            </Button>
          ) : null}
        </span>
      </div>
      {!cart.recoverySentAt && !cart.windowOpen && (
        <div className="mx-5 mb-3">
          <WarnNote>Passaram as 24 h da última mensagem do cliente. A mensagem só sai depois que ele escrever de novo.</WarnNote>
        </div>
      )}
      {error && (
        <div className="mx-5 mb-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}
    </li>
  );
}
