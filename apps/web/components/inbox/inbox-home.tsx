"use client";

import { CHANNEL_LABEL, type ChannelHealthDto, INTEGRATION_TYPES, type IntegrationType, type OrderPage } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircleIcon, MessageSquareIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/components/auth/auth-provider";
import { ORDER_TONE } from "@/components/clients/client-detail";
import { ChannelDot, StatusBadge } from "@/components/inbox/bits";
import { ORDER_STATUS } from "@/components/inbox/order-card";
import { type Badge, STATUS, StatusBadge as IntegrationBadge, SystemIcon } from "@/components/settings/integrations-tab";
import { Button, buttonVariants } from "@/components/ui/button";
import { clock, count, currency } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Sempre na lista, conectados ou não; os demais sistemas só aparecem depois de conectados. */
const ALWAYS: IntegrationType[] = ["WHATSAPP", "INSTAGRAM", "IFOOD"];

const ARRIVES: Record<IntegrationType, string> = {
  WHATSAPP: "Conversas do WhatsApp do restaurante",
  INSTAGRAM: "Mensagens diretas da conta profissional",
  IFOOD: "Pedidos das lojas do iFood",
  CARDAPIO_WEB: "Pedidos das lojas do Cardápio Web",
};

/**
 * Inbox sem conversa aberta: a situação de cada integração (com o atalho para conectar) e a barra lateral com os
 * pedidos de hoje. O design ainda não tem este estado; segue o cartão de Integrações e o painel do cliente. Desktop no MVP.
 */
export function InboxHome() {
  return (
    <>
      <div className="flex min-w-0 flex-1 overflow-y-auto">
        <div className="m-auto w-full max-w-[460px] px-6 py-10">
          <Integrations />
          <p className="mt-8 flex items-center justify-center gap-2 text-ink-3">
            <MessageSquareIcon className="size-4" aria-hidden />
            Escolha uma conversa na lista para responder.
          </p>
        </div>
      </div>
      <TodayOrders />
    </>
  );
}

function Integrations() {
  const { request, session } = useAuth();
  // Mesma consulta da faixa de canal desconectado (ChannelAlert).
  const channels = useQuery({
    queryKey: ["channels"],
    queryFn: () => request<ChannelHealthDto[]>("/channels"),
    refetchInterval: 60_000,
  });
  const admin = (session?.context?.tenants ?? []).some((tenant) => tenant.role === "ADMIN");

  if (!channels.data) {
    return (
      <div className="flex justify-center py-6 text-ink-3">
        {channels.isError ? "Não foi possível carregar as integrações." : <LoaderCircleIcon className="size-4 animate-spin" aria-label="Carregando…" />}
      </div>
    );
  }
  const list = channels.data;
  const types = INTEGRATION_TYPES.filter((type) => ALWAYS.includes(type) || list.some((channel) => channel.type === type));

  return (
    <section aria-labelledby="inbox-integracoes">
      <h2 id="inbox-integracoes" className="font-heading text-[16px] font-bold tracking-[-0.3px]">
        Integrações
      </h2>
      <p className="mt-0.5 mb-4 text-ink-3">Por onde chegam as conversas e os pedidos.</p>
      <ul className="overflow-hidden rounded-2xl border border-rule-soft bg-surface">
        {types.map((type) => (
          <IntegrationRow key={type} type={type} channels={list.filter((channel) => channel.type === type)} admin={admin} />
        ))}
      </ul>
      {admin ? (
        <Link
          href="/configuracoes/integracoes?conectar=nova"
          className={cn(buttonVariants({ variant: "ghost" }), "mt-2 -ml-2 px-2 text-tomate hover:bg-tomate-lt hover:text-tomate")}
        >
          <PlusIcon aria-hidden />
          Conectar nova integração
        </Link>
      ) : (
        <p className="mt-3 text-[12px] text-ink-3">Só o administrador do restaurante conecta integrações.</p>
      )}
    </section>
  );
}

/** Uma linha por sistema, com a mesma regra do cartão de Integrações: erro, conectado ou não conectado. */
function IntegrationRow({ type, channels, admin }: { type: IntegrationType; channels: ChannelHealthDto[]; admin: boolean }) {
  const active = channels.filter((channel) => channel.status !== "DISCONNECTED");
  const broken = active.some((channel) => channel.status === "ERROR") || (channels.length > 0 && active.length === 0);
  const badge: Badge = broken
    ? { ...STATUS.ERROR, label: active.length > 0 ? "Com erro" : "Desconectado" }
    : active.length > 0
      ? STATUS.CONNECTED
      : { ...STATUS.DISCONNECTED, label: "Não conectado" };
  // Sem conta: a nova conexão; com conta parada: o modal das contas, para reconectar.
  const action = channels.length === 0 ? { label: "Conectar", href: `?conectar=${type}` } : broken ? { label: "Reconectar", href: `?gerenciar=${type}` } : null;

  return (
    <li className="flex items-center gap-3 border-rule-soft px-4 py-3 [&+&]:border-t">
      <SystemIcon type={type} className="size-9 rounded-[9px] text-[12px]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold">{CHANNEL_LABEL[type]}</span>
          <IntegrationBadge badge={badge} />
        </div>
        <p className="mt-0.5 truncate text-[11px] text-ink-3">
          {active.length > 0 ? active.map((channel) => channel.name).join(", ") : ARRIVES[type]}
        </p>
      </div>
      {admin && action && (
        <Link href={`/configuracoes/integracoes${action.href}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "text-ink-2")}>
          {action.label}
        </Link>
      )}
    </li>
  );
}

/** Barra lateral com os pedidos de hoje (a mesma consulta da aba Pedidos, que tem os detalhes e as ações). */
function TodayOrders() {
  const { request, session } = useAuth();
  const master = session?.context?.mode === "master";
  const params = new URLSearchParams({ period: "today", page: "1" });
  const orders = useQuery({
    queryKey: ["orders", params.toString()],
    queryFn: () => request<OrderPage>(`/orders?${params}`),
    refetchInterval: 30_000, // os pedidos chegam pelo polling das integrações
  });
  const data = orders.data;
  // Soma só com todos os pedidos do dia na página (até 50).
  const sum = data && data.total <= data.items.length ? data.items.filter((order) => order.status !== "CANCELED").reduce((total, order) => total + Number(order.total), 0) : null;

  return (
    <aside aria-labelledby="inbox-pedidos-hoje" className="flex w-[344px] shrink-0 flex-col border-l border-rule bg-surface">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-rule px-4 pt-4 pb-3.5">
        <div>
          <h2 id="inbox-pedidos-hoje" className="font-heading text-[16px] font-bold tracking-[-0.3px]">
            Pedidos de hoje
          </h2>
          <p className="mt-0.5 text-xs text-ink-3 tabular-nums">
            {data ? `${count(data.total)} ${data.total === 1 ? "pedido" : "pedidos"}${sum !== null && sum > 0 ? ` · ${currency(sum)}` : ""}` : " "}
          </p>
        </div>
        <Link href="/pedidos" className={cn(buttonVariants({ variant: "outline", size: "xs" }), "text-ink-2")}>
          {data && data.total > data.items.length ? `Ver os ${count(data.total)}` : "Abrir Pedidos"}
        </Link>
      </div>

      {/* pb-20: o widget do iFood fica fixo no canto de baixo e cobriria o último pedido. */}
      <div className="flex-1 overflow-y-auto pb-20">
        {orders.isPending ? (
          <div className="flex justify-center py-8 text-ink-3">
            <LoaderCircleIcon className="size-4 animate-spin" aria-label="Carregando…" />
          </div>
        ) : orders.isError ? (
          <div className="px-4 py-6 text-ink-3">
            <p className="mb-2.5">Não foi possível carregar os pedidos.</p>
            <Button variant="outline" size="sm" onClick={() => orders.refetch()}>
              Tentar novamente
            </Button>
          </div>
        ) : data!.items.length === 0 ? (
          <p className="px-4 py-8 text-center leading-normal text-ink-3">
            Nenhum pedido hoje.
            <br />
            Os pedidos do iFood e do Cardápio Web aparecem aqui assim que chegam.
          </p>
        ) : (
          <ul>
            {data!.items.map((order) => (
              <li key={order.id} className="border-b border-rule-soft px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <ChannelDot type={order.channelType} className="size-2" />
                  <span className="font-medium tabular-nums">#{order.displayCode ?? order.id.slice(0, 6)}</span>
                  <Link href={`/clientes/${order.contact.id}`} className="min-w-0 flex-1 truncate text-ink-2 hover:text-tomate hover:underline">
                    {order.contact.name ?? "Cliente sem nome"}
                  </Link>
                  <span className="text-[11px] text-ink-3 tabular-nums">{clock(order.placedAt)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2 pl-4">
                  <span className="truncate text-xs text-ink-3 tabular-nums">
                    {currency(order.total)}
                    {master && ` · ${order.tenant.name}`}
                  </span>
                  <StatusBadge tone={ORDER_TONE[order.status]}>{ORDER_STATUS[order.status].label}</StatusBadge>
                </div>
                {order.dispute && <p className="mt-0.5 pl-4 text-[11px] text-warning">Cliente pediu cancelamento</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
