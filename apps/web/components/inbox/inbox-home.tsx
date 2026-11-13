"use client";

import {
  type AiAttendanceDto,
  CHANNEL_LABEL,
  type ChannelHealthDto,
  type ConversationCounts,
  type ConversationDayStats,
  INTEGRATION_TYPES,
  type IntegrationType,
  type OrderListItem,
  type OrderPage,
  type OrderStageCounts,
} from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangleIcon,
  BotIcon,
  LoaderCircleIcon,
  PlusIcon,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { ORDER_TONE } from "@/components/clients/client-detail";
import { useIfoodWidget } from "@/components/ifood-widget";
import { ChannelDot, StatusBadge } from "@/components/inbox/bits";
import { ORDER_STATUS } from "@/components/inbox/order-card";
import { SetupReminder } from "@/components/onboarding/setup-reminder";
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
import { ago, clock, count, currency, responseTime, score } from "@/lib/format";
import { setIfoodWidgetChoice, useIfoodWidgetChoice } from "@/lib/ifood-widget-choice";
import { cn } from "@/lib/utils";

/** Sempre na lista, conectados ou não; os demais sistemas só aparecem depois de conectados. */
const ALWAYS: IntegrationType[] = ["WHATSAPP", "INSTAGRAM", "IFOOD"];

const ARRIVES: Record<IntegrationType, string> = {
  WHATSAPP: "Conversas do WhatsApp do restaurante",
  INSTAGRAM: "Mensagens diretas da conta profissional",
  IFOOD: "Pedidos das lojas do iFood",
  CARDAPIO_WEB: "Pedidos das lojas do Cardápio Web",
  NEEMO: "Pedidos das lojas da Neemo",
};

/**
 * Inbox sem conversa aberta: os números do dia e a situação de cada integração (com o atalho para conectar). A barra
 * lateral com os pedidos de hoje (TodayOrders) fica na InboxView. O design ainda não tem este estado; segue o cartão de
 * Integrações e o painel do cliente. Desktop no MVP.
 */
export function InboxHome({ onOpenCalling }: { onOpenCalling: () => void }) {
  return (
    <div className="@container flex min-w-0 flex-1 overflow-y-auto border-r border-rule bg-paper">
      <div className="mx-auto w-full max-w-[720px] px-4 pt-7 pb-10 @lg:px-6">
        <SetupReminder />
        <Today onOpenCalling={onOpenCalling} />
        {/* As integrações vêm antes da IA: a equipe vê logo se alguma está falhando. */}
        <Integrations />
        <AiAttendance />
      </div>
    </div>
  );
}

const TILE = "rounded-2xl border border-rule-soft bg-surface px-4 py-3.5 text-left";

function Tile({ label, value, suffix, tone, children }: { label: string; value: string | undefined; suffix?: string; tone?: string; children: ReactNode }) {
  return (
    <>
      <span className="block text-[12px] font-medium text-ink-2">{label}</span>
      <b className={cn("my-1.5 block font-heading text-[28px] leading-none font-bold tabular-nums", tone)}>
        {value ?? "–"}
        {suffix && <small className="ml-1 font-sans text-[13px] font-medium text-ink-3">{suffix}</small>}
      </b>
      <small className="text-[11.5px] text-ink-3 tabular-nums">{children}</small>
    </>
  );
}

/**
 * Conversas do dia até agora: abertas (o cliente escreveu hoje), resolvidas, resolvidas sem a equipe, quantas chamaram a
 * equipe (com quem espera agora: o clique abre quem espera há mais tempo), o tempo de resposta da equipe e a nota da
 * pesquisa. As chaves em "counts" fazem o realtime atualizar os números.
 */
function Today({ onOpenCalling }: { onOpenCalling: () => void }) {
  const { request } = useAuth();
  const now = useNow(60_000);
  const today = useQuery({
    queryKey: ["counts", "today"],
    queryFn: () => request<ConversationDayStats>("/conversations/today"),
  });
  const counts = useQuery({ queryKey: ["counts", null], queryFn: () => request<ConversationCounts>("/conversations/counts") });
  const data = today.data;
  const waiting = counts.data ? counts.data.awaitingAgent - counts.data.awaitingQuiet : 0;
  const whole = (amount: number | undefined) => (amount === undefined ? undefined : count(amount));
  const share = data && data.resolved > 0 ? Math.round((data.resolvedWithoutTeam / data.resolved) * 100) : null;

  return (
    <section aria-labelledby="inbox-hoje" className="mb-[30px]">
      <h2 id="inbox-hoje" className="font-heading text-[16px] font-bold tracking-[-0.3px]">
        Hoje até agora
      </h2>
      <p className="mt-0.5 mb-4 text-ink-3">Conversas desde a meia-noite.</p>
      <div className="grid grid-cols-1 gap-2.5 @xl:grid-cols-3">
        <div className={TILE}>
          <Tile label="Conversas abertas" value={whole(data?.opened)}>
            clientes que escreveram hoje
          </Tile>
        </div>
        <div className={TILE}>
          <Tile label="Resolvidas" value={whole(data?.resolved)}>
            {data ? `${count(data.opened - data.resolved)} ainda em aberto` : " "}
          </Tile>
        </div>
        <div className={TILE}>
          <Tile label="Resolvidas sem a equipe" value={whole(data?.resolvedWithoutTeam)} tone="text-success">
            {share === null ? "só com a IA e as automações" : `${share}% das resolvidas, só com a IA e as automações`}
          </Tile>
        </div>
        <button
          type="button"
          onClick={onOpenCalling}
          disabled={waiting === 0}
          className={cn(TILE, "disabled:cursor-default", waiting > 0 && "border-tomate-line bg-tomate-lt hover:border-tomate")}
        >
          <Tile label="Chamaram a equipe" value={whole(data?.calledTeam)}>
            {waiting > 0 ? (
              <span className="font-medium text-tomate">
                {waiting === 1 ? "1 esperando agora" : `${count(waiting)} esperando agora`}
                {counts.data?.urgentSince && `, há ${ago(counts.data.urgentSince, now)}`}
              </span>
            ) : (
              "ninguém esperando agora"
            )}
          </Tile>
        </button>
        <div className={TILE}>
          <Tile label="Tempo de resposta" value={data?.averageResponseSeconds == null ? undefined : responseTime(data.averageResponseSeconds)}>
            média até a primeira resposta da equipe
          </Tile>
        </div>
        <div className={TILE}>
          <Tile label="Nota do atendimento" value={data?.averageScore == null ? undefined : score(data.averageScore)} suffix={data?.averageScore == null ? undefined : "/ 5"}>
            {data ? (data.ratings === 0 ? "nenhuma avaliação hoje" : `${count(data.ratings)} ${data.ratings === 1 ? "avaliação" : "avaliações"} hoje`) : " "}
          </Tile>
        </div>
      </div>
    </section>
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
  const widgetChoice = useIfoodWidgetChoice();
  const widgetOff = (widget.data?.merchantIds.length ?? 0) > 0 && (widgetChoice === "off" || widgetChoice === "later");

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
    <section aria-labelledby="inbox-integracoes" className="mb-[30px]">
      <h2 id="inbox-integracoes" className="font-heading text-[16px] font-bold tracking-[-0.3px]">
        Integrações
      </h2>
      <p className="mt-0.5 mb-4 text-ink-3">Por onde chegam as conversas e os pedidos.</p>
      <ul className="grid grid-cols-1 gap-2.5 @2xl:grid-cols-2">
        {types.map((type) => (
          <IntegrationRow key={type} type={type} channels={list.filter((channel) => channel.type === type)} admin={admin} />
        ))}
        {widgetOff ? (
          <IfoodWidgetOffRow />
        ) : (
          widget.data?.chat && widget.data.merchantIds.length > 0 && <IfoodChatRow storeUrl={widget.data.extensionUrl} />
        )}
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

/**
 * Atendimento com IA (restaurantes com o módulo): quem responde os clientes agora. No "100% automático", fechado ou sem
 * ninguém online, a IA responde tudo e quem pede um atendente espera; o administrador liga e desliga o 100% automático.
 */
function AiAttendance() {
  const { request, session } = useAuth();
  const queryClient = useQueryClient();
  const attendance = useQuery({
    queryKey: ["ai-attendance"],
    queryFn: () => request<AiAttendanceDto[]>("/ai/attendance"),
    refetchInterval: 30_000,
  });
  if (!attendance.data?.length) return null;
  const admin = (tenantId: string) => (session?.context?.tenants ?? []).some((tenant) => tenant.id === tenantId && tenant.role === "ADMIN");
  const toggle = async (tenantId: string, enabled: boolean) => {
    await request(`/ai/${tenantId}/full-auto`, { method: "PUT", body: { enabled } });
    await queryClient.invalidateQueries({ queryKey: ["ai-attendance"] });
  };

  return (
    <section aria-labelledby="inbox-ia">
      <h2 id="inbox-ia" className="font-heading text-[16px] font-bold tracking-[-0.3px]">
        Atendimento com IA
      </h2>
      <p className="mt-0.5 mb-4 text-ink-3">Quem responde os clientes agora.</p>
      <ul className="overflow-hidden rounded-2xl border border-rule-soft bg-surface">
        {attendance.data.map((tenant) => (
          <AiAttendanceRow
            key={tenant.tenantId}
            tenant={tenant}
            showName={attendance.data.length > 1}
            onToggle={admin(tenant.tenantId) ? () => toggle(tenant.tenantId, !tenant.fullAuto) : undefined}
          />
        ))}
      </ul>
    </section>
  );
}

function AiAttendanceRow({ tenant, showName, onToggle }: { tenant: AiAttendanceDto; showName: boolean; onToggle?: () => Promise<void> }) {
  const badge: Badge = tenant.fullAuto
    ? { label: "100% automático", className: "bg-warning-lt text-warning-ink", dot: "bg-warning" }
    : tenant.closed
      ? { label: "Fechado", className: "bg-surface-2 text-ink-3", dot: "bg-ink-3" }
      : { label: "IA + equipe", className: "bg-success-lt text-success-ink", dot: "bg-success" };
  const text = tenant.fullAuto
    ? "A IA responde tudo e não chama a equipe. Quem pedir um atendente espera até o 100% automático ser desligado."
    : tenant.closed
      ? "Restaurante fechado: a IA responde tudo, e quem pedir um atendente vai para a equipe quando abrir."
      : "A IA responde e passa para a equipe quando o cliente precisa de alguém.";

  return (
    <li className="flex items-center gap-3 border-rule-soft px-4 py-3 [&+&]:border-t">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-ink text-paper">
        <BotIcon className="size-[18px]" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold">{showName ? tenant.tenantName : "IA"}</span>
          <IntegrationBadge badge={badge} />
        </div>
        <p className="mt-0.5 text-[11px] text-ink-3">
          {text}
          {tenant.waiting > 0 && (
            <span className="font-medium text-warning-ink tabular-nums">
              {" "}
              {tenant.waiting === 1 ? "1 cliente esperando atendente." : `${count(tenant.waiting)} clientes esperando atendente.`}
            </span>
          )}
        </p>
      </div>
      {onToggle && (
        <Button variant="outline" size="sm" className="shrink-0 text-ink-2" onClick={onToggle}>
          {tenant.fullAuto ? "Desligar" : "Ligar 100% automático"}
        </Button>
      )}
    </li>
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
    <li className="flex items-center gap-3 rounded-2xl border border-rule-soft bg-surface px-4 py-3">
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

/** Widget do iFood recusado neste computador ("Não" na pergunta do Dish Desk): religa por aqui. */
function IfoodWidgetOffRow() {
  return (
    <li className="flex items-center gap-3 rounded-2xl border border-rule-soft bg-surface px-4 py-3">
      <SystemIcon type="IFOOD" className="size-9 rounded-[9px] text-[12px]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold">Widget do iFood</span>
          <IntegrationBadge badge={{ label: "Desligado", className: "bg-surface-2 text-ink-3", dot: "bg-ink-3" }} />
        </div>
        <p className="mt-0.5 text-[11px] text-ink-3">Desligado neste computador: o chat e as notificações do iFood não aparecem aqui.</p>
      </div>
      <Button variant="outline" size="sm" className="text-ink-2" onClick={() => setIfoodWidgetChoice("on")}>
        Usar aqui
      </Button>
    </li>
  );
}

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
    <li className="flex items-center gap-3 rounded-2xl border border-rule-soft bg-surface px-4 py-3">
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

const PRODUCTION = new URLSearchParams({ period: "today", production: "true", page: "1" }).toString();

/** Pedidos de hoje ainda em produção (a mesma consulta na barra do início e na aba Pedidos da conversa). */
export function useProductionOrders() {
  const { request } = useAuth();
  return useQuery({
    queryKey: ["orders", PRODUCTION],
    queryFn: () => request<OrderPage>(`/orders?${PRODUCTION}`),
    refetchInterval: 30_000, // os pedidos chegam pelo polling das integrações
  });
}

/**
 * Pedidos de hoje ainda em produção, do mais antigo para o mais novo, com o alerta de atraso e o número de cada etapa no
 * topo. O clique abre o pedido num modal com os detalhes e as ações da aba Pedidos. Sem conversa aberta, é a barra da
 * direita do início; com uma conversa, é a aba Pedidos do painel dela (`embedded`).
 */
export function TodayOrders({ embedded }: { embedded?: boolean }) {
  const { request, session } = useAuth();
  const master = session?.context?.mode === "master";
  const now = useNow(60_000);
  const [selected, setSelected] = useState<OrderListItem | null>(null);
  const orders = useProductionOrders();
  const stages = useQuery({
    queryKey: ["orders", "stages"],
    queryFn: () => request<OrderStageCounts>("/orders/stages"),
    refetchInterval: 30_000,
  });
  const data = orders.data;
  // Atrasados em produção e prontos (a lista de produção inclui os prontos que ainda não saíram).
  const late = data?.items.filter((order) => order.late).length ?? 0;
  // O modal acompanha a lista; o pedido que sai da produção (ex.: despachado) continua aberto como estava.
  const open = selected && (data?.items.find((order) => order.id === selected.id) ?? selected);
  const strip = [
    { label: "Em produção", value: stages.data?.production },
    { label: "Atrasados", value: data && late, alert: late > 0 },
    { label: "Prontos", value: stages.data?.ready },
    { label: "Em rota", value: stages.data?.dispatched },
    { label: "Entregues", value: stages.data?.delivered },
  ];
  const openOrders = (
    <Link href="/pedidos" className={cn(buttonVariants({ variant: "outline", size: embedded ? "sm" : "xs" }), "text-ink-2")}>
      {data && data.total > data.items.length ? `Ver os ${count(data.total)}` : "Abrir Pedidos"}
    </Link>
  );

  const body = (
    <>
      <div className="grid shrink-0 grid-cols-5 border-b border-rule" aria-label="Pedidos de hoje por etapa">
        {strip.map((stage) => (
          <div key={stage.label} className="border-rule-soft px-0.5 pt-2.5 pb-2 text-center [&+&]:border-l">
            <b className={cn("block text-[15px] leading-tight font-semibold tabular-nums", stage.alert && "text-tomate")}>
              {stage.value === undefined ? "–" : count(stage.value)}
            </b>
            <span className={cn("text-[10px] whitespace-nowrap text-ink-3", stage.alert && "text-tomate")}>{stage.label}</span>
          </div>
        ))}
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
                      {currency(order.total)} · {order.store}
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
        {embedded && <div className="px-4 py-3">{openOrders}</div>}
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
                  {` · ${open.store} · feito às ${clock(open.placedAt)} (${ago(open.placedAt, now)}) · ${currency(open.total)}`}
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
    </>
  );

  if (embedded) return <div className="flex min-h-0 flex-1 flex-col">{body}</div>;
  return (
    <aside aria-labelledby="inbox-pedidos-hoje" className="flex w-[clamp(288px,26vw,344px)] shrink-0 flex-col bg-surface">
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
        {openOrders}
      </div>
      {body}
    </aside>
  );
}
