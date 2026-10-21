"use client";

import {
  CHANNEL_LABEL,
  type ChannelHealthDto,
  INTEGRATION_TYPES,
  type IntegrationType,
  type OrderListItem,
  type OrderPage,
} from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PlusIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { ORDER_TONE } from "@/components/clients/client-detail";
import { useIfoodWidget } from "@/components/ifood-widget";
import { ChannelDot, StatusBadge } from "@/components/inbox/bits";
import { ORDER_STATUS } from "@/components/inbox/order-card";
import { OrderDetails } from "@/components/orders/order-list";
import {
  type Badge,
  CloseButton,
  STATUS,
  StatusBadge as IntegrationBadge,
  SystemIcon,
} from "@/components/settings/integrations-tab";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { connectIfoodChat, type IfoodChatStatus, useIfoodChatState } from "@/hooks/use-ifood-chat";
import { useNow } from "@/hooks/use-now";
import { ago, clock, count, currency } from "@/lib/format";
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
 * Inbox sem conversa aberta: a situação de cada integração (com o atalho para conectar). A barra lateral com os pedidos
 * de hoje (TodayOrders) fica na InboxView. O design ainda não tem este estado; segue o cartão de Integrações e o painel
 * do cliente. Desktop no MVP.
 */
export function InboxHome() {
  return (
    <div className="flex min-w-0 flex-1 overflow-y-auto">
      <div className="m-auto w-full max-w-[460px] px-6 py-10">
        <Integrations />
        <p className="mt-8 flex items-center justify-center gap-2 text-ink-3">
          <MessageSquareIcon className="size-4" aria-hidden />
          Escolha uma conversa na lista para responder.
        </p>
      </div>
    </div>
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
  const widget = useIfoodWidget();

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
        {widget.data?.chat && widget.data.merchantIds.length > 0 && <IfoodChatRow storeUrl={widget.data.extensionUrl} />}
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

const CHECKING: Badge = { label: "Verificando", className: "bg-surface-2 text-ink-3", dot: "bg-ink-3" };
const CHAT_BADGE: Record<IfoodChatStatus, Badge> = {
  off: CHECKING,
  checking: CHECKING,
  missing: { ...STATUS.ERROR, label: "Desconectado" },
  unauthorized: { ...STATUS.ERROR, label: "Desconectado" },
  authorizing: { label: "Autorizando", className: "bg-warning-lt text-warning-ink", dot: "bg-warning" },
  connected: STATUS.CONNECTED,
};
const CHAT_TEXT: Record<IfoodChatStatus, string> = {
  off: "Procurando o widget do iFood…",
  checking: "Procurando o widget do iFood e a extensão do Chrome…",
  missing: "Falta a extensão do Dish Desk neste Chrome. Depois de instalar, recarregue a página.",
  unauthorized: "A loja ainda não autorizou o widget do iFood neste computador.",
  authorizing: "Termine a autorização no Portal do Parceiro: o chat conecta sozinho.",
  connected: "As conversas do iFood chegam à Inbox por este computador.",
};

/**
 * Chat do iFood (trava IFOOD_CHAT_BRIDGE), que depende deste navegador: a extensão do Chrome e a autorização do widget
 * pela loja. "Conectar" abre o Portal do Parceiro pelo convite do widget; "Instalar", a página da extensão.
 */
function IfoodChatRow({ storeUrl }: { storeUrl?: string | null }) {
  const { status, invite } = useIfoodChatState();
  const action =
    status === "missing" && storeUrl
      ? {
          label: "Instalar",
          run: () => {
            window.open(storeUrl, "_blank", "noopener");
            // Segura o botão por um instante: um duplo clique abriria a loja duas vezes.
            return new Promise((resolve) => setTimeout(resolve, 1_000));
          },
        }
      : status === "unauthorized" && invite
        ? { label: "Conectar", run: () => connectIfoodChat().catch(() => undefined) }
        : null;

  return (
    <li className="flex items-center gap-3 border-rule-soft px-4 py-3 [&+&]:border-t">
      <SystemIcon type="IFOOD" className="size-9 rounded-[9px] text-[12px]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold">Chat do iFood</span>
          <IntegrationBadge badge={CHAT_BADGE[status]} />
        </div>
        <p className="mt-0.5 text-[11px] text-ink-3">
          {status === "unauthorized" && !invite ? "Autorize pelo convite do widget do iFood, no canto da tela." : CHAT_TEXT[status]}
        </p>
      </div>
      {action && (
        <Button variant="outline" size="sm" className="text-ink-2" onClick={action.run}>
          {action.label}
        </Button>
      )}
    </li>
  );
}

/**
 * Barra lateral com os pedidos de hoje ainda em produção, do mais antigo para o mais novo, com o alerta de atraso. O
 * clique abre o pedido num modal com os detalhes e as ações da aba Pedidos. Com uma conversa aberta, a barra fica
 * recolhida numa faixa no canto (com a contagem e os atrasados) até o atendente expandir.
 */
export function TodayOrders({ collapsed, onToggle }: { collapsed?: boolean; onToggle?: () => void }) {
  const { request, session } = useAuth();
  const master = session?.context?.mode === "master";
  const now = useNow(60_000);
  const [selected, setSelected] = useState<OrderListItem | null>(null);
  const params = new URLSearchParams({ period: "today", production: "true", page: "1" });
  const orders = useQuery({
    queryKey: ["orders", params.toString()],
    queryFn: () => request<OrderPage>(`/orders?${params}`),
    refetchInterval: 30_000, // os pedidos chegam pelo polling das integrações
  });
  const data = orders.data;
  const late = data?.items.filter((order) => order.late).length ?? 0;
  // O modal acompanha a lista; o pedido que sai da produção (ex.: despachado) continua aberto como estava.
  const open = selected && (data?.items.find((order) => order.id === selected.id) ?? selected);

  if (collapsed) {
    return (
      <aside aria-label="Pedidos em produção" className="flex w-11 shrink-0 flex-col items-center border-l border-rule bg-surface pt-2">
        <Button variant="ghost" size="icon-sm" onClick={onToggle} aria-label="Mostrar pedidos em produção" title="Mostrar pedidos em produção">
          <PanelRightOpenIcon aria-hidden />
        </Button>
        <button
          type="button"
          onClick={onToggle}
          className="mt-2 flex flex-col items-center gap-1.5 rounded-lg px-1 py-2 text-ink-3 hover:bg-paper hover:text-ink"
        >
          <span className="text-[13px] font-semibold text-ink tabular-nums">{data ? count(data.total) : "–"}</span>
          {late > 0 && (
            <span className="rounded-full bg-tomate px-1.5 text-[10px] leading-4 font-semibold text-white tabular-nums" title="Atrasados">
              {count(late)}
            </span>
          )}
          <span className="text-[11px] font-medium [writing-mode:vertical-rl]">Em produção</span>
        </button>
      </aside>
    );
  }

  return (
    <aside aria-labelledby="inbox-pedidos-hoje" className="flex w-[344px] shrink-0 flex-col border-l border-rule bg-surface">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-rule px-4 pt-4 pb-3.5">
        <div>
          <h2 id="inbox-pedidos-hoje" className="font-heading text-[16px] font-bold tracking-[-0.3px]">
            Em produção
          </h2>
          <p className="mt-0.5 text-xs text-ink-3 tabular-nums">
            {data ? `${count(data.total)} ${data.total === 1 ? "pedido" : "pedidos"}` : " "}
            {late > 0 && <span className="font-medium text-tomate"> · {late === 1 ? "1 atrasado" : `${count(late)} atrasados`}</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Link href="/pedidos" className={cn(buttonVariants({ variant: "outline", size: "xs" }), "text-ink-2")}>
            {data && data.total > data.items.length ? `Ver os ${count(data.total)}` : "Abrir Pedidos"}
          </Link>
          {onToggle && (
            <Button variant="ghost" size="icon-xs" onClick={onToggle} aria-label="Recolher pedidos em produção" title="Recolher">
              <PanelRightCloseIcon aria-hidden />
            </Button>
          )}
        </div>
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
            Nenhum pedido em produção.
            <br />
            Os pedidos do iFood e do Cardápio Web aparecem aqui assim que chegam.
          </p>
        ) : (
          <ul>
            {data!.items.map((order) => (
              <li key={order.id} className="border-b border-rule-soft">
                <button
                  type="button"
                  onClick={() => setSelected(order)}
                  className={cn(
                    "w-full border-l-[3px] px-4 py-2.5 pl-[13px] text-left",
                    order.late ? "border-tomate bg-tomate-lt hover:bg-tomate-lt/70" : "border-transparent hover:bg-paper",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <ChannelDot type={order.channelType} className="size-2" />
                    <span className="font-medium tabular-nums">#{order.displayCode ?? order.id.slice(0, 6)}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-2">{order.contact.name ?? "Cliente sem nome"}</span>
                    <span className={cn("text-[11px] tabular-nums", order.late ? "font-medium text-tomate" : "text-ink-3")}>
                      {clock(order.placedAt)} · {ago(order.placedAt, now)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 pl-4">
                    <span className="truncate text-xs text-ink-3 tabular-nums">
                      {currency(order.total)}
                      {master && ` · ${order.tenant.name}`}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {order.late && (
                        <StatusBadge tone="open">
                          <AlertTriangleIcon className="mr-0.5 size-2.5" aria-hidden />
                          Atrasado
                        </StatusBadge>
                      )}
                      <StatusBadge tone={ORDER_TONE[order.status]}>{ORDER_STATUS[order.status].label}</StatusBadge>
                    </span>
                  </div>
                  {order.dispute && <p className="mt-0.5 pl-4 text-[11px] text-warning">Cliente pediu cancelamento</p>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={open !== null} onOpenChange={(next) => !next && setSelected(null)}>
        <DialogContent className="flex max-h-[calc(100vh-4rem)] w-[680px] flex-col">
          {open && (
            <>
              <div className="shrink-0 border-b border-rule px-6 py-5">
                <div className="mb-1 flex items-center gap-2">
                  <DialogTitle>
                    Pedido {CHANNEL_LABEL[open.channelType]} #{open.displayCode ?? open.id.slice(0, 6)}
                  </DialogTitle>
                  {open.late && <StatusBadge tone="open">Atrasado</StatusBadge>}
                  <StatusBadge tone={ORDER_TONE[open.status]}>{ORDER_STATUS[open.status].label}</StatusBadge>
                  <CloseButton onClick={() => setSelected(null)} />
                </div>
                <DialogDescription className="tabular-nums">
                  <Link href={`/clientes/${open.contact.id}`} className="text-ink-2 hover:text-tomate hover:underline">
                    {open.contact.name ?? "Cliente sem nome"}
                  </Link>
                  {` · feito às ${clock(open.placedAt)} (${ago(open.placedAt, now)}) · ${currency(open.total)}`}
                  {master && ` · ${open.tenant.name}`}
                </DialogDescription>
              </div>
              <div className="overflow-y-auto bg-paper px-6 py-4">
                <OrderDetails order={open} />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </aside>
  );
}
