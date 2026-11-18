"use client";

import { CHANNEL_LABEL, type CurrentOrderDto, type OrderDto } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { CHANNEL_DOT } from "@/components/inbox/bits";
import { ForecastButton, NOTIFIABLE, ORDER_STATUS } from "@/components/inbox/order-card";
import { historyText } from "@/components/orders/customer-history";
import { useNow } from "@/hooks/use-now";
import { clock, currency, responseTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Cores do status no cabeçalho do bloco, quando diferem das do card do pedido. */
const STATUS_TONE: Partial<Record<OrderDto["status"], string>> = {
  READY: "text-[#2F6FB7] dark:text-[#6EA8F0]",
  DISPATCHED: "text-[#C2610F] dark:text-[#F08A3C]",
};

/**
 * Pedido ligado ao cliente da conversa (painel lateral; o design ainda não tem este bloco): achado sozinho pelo
 * cadastro ao abrir a conversa, com itens, observações e o andamento até a saída prevista e a entrega prometida.
 */
export function CurrentOrder({ conversationId }: { conversationId: string }) {
  const { request } = useAuth();
  const query = useQuery({
    queryKey: ["current-order", conversationId],
    queryFn: () => request<{ current: CurrentOrderDto | null }>(`/orders/current?conversationId=${conversationId}`),
    refetchInterval: 30_000, // a previsão e o status mudam com a cozinha (as plataformas são consultadas a cada 30s)
  });
  const current = query.data?.current;
  if (!current) return null;
  const { order } = current;
  const status = ORDER_STATUS[order.status];

  return (
    <div className="flex flex-col gap-4 border-b border-rule px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Pedido do cliente</div>
        <span className={cn("text-[12px] font-semibold", STATUS_TONE[order.status] ?? status.className)}>{status.label}</span>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className={cn("size-2 shrink-0 rounded-full", CHANNEL_DOT[order.channelType])} />
          <span className="shrink-0 text-[16px] font-bold">
            {CHANNEL_LABEL[order.channelType]} #{order.displayCode ?? order.id.slice(0, 6)}
          </span>
          {order.restaurantName && <span className="truncate text-[12px] text-ink-3">· {order.restaurantName}</span>}
          <span className="ml-auto shrink-0 text-[15px] font-medium text-ink-2 tabular-nums">{currency(order.total)}</span>
        </div>
        <p className="text-[13px] text-ink-3">{historyText(current.history)}</p>
      </div>

      <ul className="flex flex-col gap-1 text-[14px] font-semibold">
        {order.items.map((item, index) => (
          <li key={index}>
            {item.quantity}× {item.name}
            {item.notes && <div className="text-[11px] font-normal text-ink-3 italic">Obs.: {item.notes}</div>}
          </li>
        ))}
      </ul>
      {current.notes.length > 0 && (
        <div className="rounded-md border border-warning-line bg-warning-lt px-2.5 py-2 text-[11.5px] text-warning-ink">
          {current.notes.map((note, index) => (
            <div key={index}>{note}</div>
          ))}
        </div>
      )}

      {current.stale ? (
        <p className="text-[11px] text-ink-3">
          Sem atualização da plataforma há mais de 4 h: o status pode estar desatualizado, então não há andamento nem previsão.
        </p>
      ) : (
        order.status !== "CANCELED" && (
          <Progress current={current} action={NOTIFIABLE.has(order.status) && <ForecastButton order={order} conversationId={conversationId} size="default" />} />
        )
      )}
    </div>
  );
}

type StageKey = "preparing" | "waiting" | "route" | "delivered";
type StageState = "done" | "current" | "next";

export type OrderStage = {
  key: StageKey;
  label: string;
  /** Hora em que a etapa começou; null: ainda não começou ou a plataforma não informou. */
  startedAt: string | null;
  /** Quanto durou (ou, na etapa atual, quanto já passou); null: sem as duas pontas. */
  durationMs: number | null;
  state: StageState;
};

/** Etapa em que cada status do pedido está. A retirada não tem a etapa "Em rota". */
const STATUS_STAGE: Partial<Record<OrderDto["status"], StageKey>> = {
  PLACED: "preparing",
  CONFIRMED: "preparing",
  PREPARING: "preparing",
  READY: "waiting",
  DISPATCHED: "route",
  DELIVERED: "delivered",
};

/**
 * As etapas do pedido com o início e a duração de cada uma. Cada etapa termina quando começa a próxima que tem hora; se a
 * plataforma já informou uma etapa à frente do status, vale a mais adiantada.
 */
export function orderStages(current: CurrentOrderDto, now: number): OrderStage[] {
  const { order, takeout, startedAt, readyAt } = current;
  const stages: Pick<OrderStage, "key" | "label" | "startedAt">[] = [
    { key: "preparing", label: "Preparo", startedAt },
    { key: "waiting", label: takeout ? "Aguardando retirada" : "Aguardando entrega", startedAt: readyAt },
    ...(takeout ? [] : [{ key: "route" as const, label: "Em rota", startedAt: order.dispatchedAt }]),
    { key: "delivered", label: takeout ? "Retirado" : "Entregue", startedAt: order.deliveredAt },
  ];
  const statusStage = STATUS_STAGE[order.status];
  const byStatus = stages.findIndex((stage) => stage.key === (takeout && statusStage === "route" ? "waiting" : statusStage));
  const byTime = stages.reduce((latest, stage, index) => (stage.startedAt ? index : latest), 0);
  const active = Math.max(byStatus, byTime);

  return stages.map((stage, index) => {
    const state: StageState = index < active || stage.key === "delivered" && index === active ? "done" : index === active ? "current" : "next";
    const start = stage.startedAt ? Date.parse(stage.startedAt) : null;
    const nextStart = stages.slice(index + 1).find((later) => later.startedAt)?.startedAt;
    const end = state === "current" ? now : nextStart ? Date.parse(nextStart) : null;
    const durationMs = stage.key !== "delivered" && state !== "next" && start !== null && end !== null ? Math.max(0, end - start) : null;
    return { ...stage, state, durationMs };
  });
}

/** Parte da etapa atual já percorrida (0 a 1), pelo tempo até a saída prevista ou a entrega prometida; sem esse alvo, o meio. */
export function stageProgress(current: CurrentOrderDto, stage: OrderStage, now: number): number {
  const start = stage.startedAt ? Date.parse(stage.startedAt) : null;
  const target = (stage.key === "route" ? null : current.forecast?.departAt) ?? current.promisedAt;
  const end = target ? Date.parse(target) : null;
  if (start === null || end === null || end <= start) return 0.5;
  return Math.min(0.96, Math.max(0.04, (now - start) / (end - start)));
}

const ICON_PROPS = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

const STAGE_ICON: Record<StageKey, ReactNode> = {
  preparing: (
    <svg {...ICON_PROPS} className="size-4">
      <path d="M4 11h16M5 11v6a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-6M9 7c0-1 1-2 0-3M13 7c0-1 1-2 0-3" />
    </svg>
  ),
  waiting: (
    <svg {...ICON_PROPS} className="size-4">
      <path d="M5 8h14l-1 12H6L5 8zM9 8V6a3 3 0 0 1 6 0v2" />
    </svg>
  ),
  route: (
    <svg {...ICON_PROPS} className="size-[17px]">
      <circle cx="5.5" cy="17" r="2.5" />
      <circle cx="18.5" cy="17" r="2.5" />
      <path d="M8 17h6l3-6h-4M15 6h2l1.5 5M5.5 17 9 11h4" />
    </svg>
  ),
  delivered: (
    <svg {...ICON_PROPS} strokeWidth={2.6} className="size-4">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  ),
};

const STAGE_SINCE: Record<Exclude<StageKey, "delivered">, string> = { preparing: "Iniciado às", waiting: "Pronto às", route: "Saiu às" };

/** Etapa atual em destaque, com a trilha das etapas e o símbolo andando nela; embaixo, os horários e a ação. */
function Progress({ current, action }: { current: CurrentOrderDto; action?: ReactNode }) {
  const now = useNow(30_000);
  const { order, forecast } = current;
  const stages = orderStages(current, now);
  const running = stages.findIndex((item) => item.state === "current");
  const finished = running === -1;
  const index = finished ? stages.length - 1 : running;
  const stage = stages[index]!;
  const share = finished ? 1 : stageProgress(current, stage, now);
  const position = finished ? 100 : ((index + share) / stages.length) * 100;

  const departed = order.dispatchedAt !== null;
  const awaitingPickup = current.takeout && current.readyAt !== null && order.deliveredAt === null;
  const promised = current.promisedAt ? Date.parse(current.promisedAt) : null;
  const late = !finished && !awaitingPickup && !departed && (Boolean(forecast?.late) || (promised !== null && now > promised));
  const fill = late ? "bg-tomate" : "bg-ink";

  let elapsed: string | null;
  let since: string | null;
  if (finished) {
    elapsed = order.deliveredAt && `às ${clock(order.deliveredAt)}`;
    since = order.deliveredAt && `Total de ${responseTime((Date.parse(order.deliveredAt) - Date.parse(order.placedAt)) / 1000)}`;
  } else {
    elapsed = stage.durationMs === null ? null : `${responseTime(stage.durationMs / 1000)} até agora`;
    since = stage.startedAt && `${STAGE_SINCE[stage.key as keyof typeof STAGE_SINCE]} ${clock(stage.startedAt)}`;
  }
  const showForecast = !departed && !finished && forecast;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-xl bg-surface-2 p-3.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 text-[15px] font-bold">{stage.label}</span>
          {elapsed && <span className={cn("shrink-0 text-[13px] font-semibold whitespace-nowrap tabular-nums", late ? "text-tomate" : "text-ink-2")}>{elapsed}</span>}
        </div>
        <div className="relative h-8" role="img" aria-label={`${stage.label}, etapa ${index + 1} de ${stages.length}`}>
          <div className="absolute inset-x-0 top-[13px] grid h-1.5 gap-1" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
            {stages.map((item, itemIndex) => (
              <div key={item.key} className="h-1.5 overflow-hidden rounded-[3px] bg-rule">
                <div
                  className={cn("h-1.5 rounded-[3px]", finished || itemIndex < index ? "bg-success" : fill)}
                  style={{ width: `${finished || itemIndex < index ? 100 : itemIndex === index ? share * 100 : 0}%` }}
                />
              </div>
            ))}
          </div>
          <div
            className={cn(
              "absolute top-0 -ml-4 flex size-8 items-center justify-center rounded-full border-[3px] border-surface-2 transition-[left] duration-500 motion-reduce:transition-none",
              finished ? "bg-success text-white" : late ? "bg-tomate text-white" : "bg-ink text-surface",
            )}
            style={{ left: `clamp(16px, ${position.toFixed(2)}%, calc(100% - 16px))` }}
          >
            {STAGE_ICON[stage.key]}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 text-[12px] text-ink-3 tabular-nums">
          <span>{since}</span>
          <span>
            Etapa {index + 1} de {stages.length}
          </span>
        </div>
      </div>

      {(current.promisedAt || showForecast || action) && (
        <div className="flex items-center justify-between gap-3">
          <dl className="flex min-w-0 flex-col gap-1.5 tabular-nums">
            {showForecast && (
              <div>
                <dt className="text-[12px] text-ink-3">Saída prevista</dt>
                <dd className={cn("text-[15px] font-bold", forecast.late && "text-tomate")}>
                  {clock(forecast.departAt)}
                  {forecast.late && <span className="text-[12px] font-medium"> · atrasado</span>}
                </dd>
              </div>
            )}
            {current.promisedAt && (
              <div>
                <dt className="text-[12px] text-ink-3">
                  {current.takeout ? "Retirada" : "Entrega"} prometida ({CHANNEL_LABEL[order.channelType]})
                </dt>
                <dd className="text-[15px] font-bold">{clock(current.promisedAt)}</dd>
              </div>
            )}
          </dl>
          {action && <div className="ml-auto shrink-0">{action}</div>}
        </div>
      )}
      {!departed && !forecast && !awaitingPickup && !finished && (
        <p className="text-[11.5px] text-ink-3">Sem previsão de saída: ainda não há pedidos que saíram para servir de base.</p>
      )}
    </div>
  );
}
