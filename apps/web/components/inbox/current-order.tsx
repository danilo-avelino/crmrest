"use client";

import { CHANNEL_LABEL, type CurrentOrderDto, type OrderDto } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, MotorbikeIcon, ShoppingBagIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { CHANNEL_DOT } from "@/components/inbox/bits";
import { ForecastButton, NOTIFIABLE, ORDER_STATUS } from "@/components/inbox/order-card";
import { CustomerHistoryLine } from "@/components/orders/customer-history";
import { useNow } from "@/hooks/use-now";
import { clock, currency, responseTime } from "@/lib/format";
import { cn } from "@/lib/utils";

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
    <div className="flex flex-col gap-2.5 border-b border-rule px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Pedido do cliente</div>
        <span className={cn("text-[10.5px] font-medium", status.className)}>{status.label}</span>
      </div>
      <div className="flex items-center gap-1.5 text-[12.5px] font-semibold">
        <span className={cn("size-[7px] shrink-0 rounded-full", CHANNEL_DOT[order.channelType])} />
        {CHANNEL_LABEL[order.channelType]} #{order.displayCode ?? order.id.slice(0, 6)}
        {order.restaurantName && <span className="truncate font-normal text-ink-3">· {order.restaurantName}</span>}
        <span className="ml-auto font-normal text-ink-2 tabular-nums">{currency(order.total)}</span>
      </div>

      <CustomerHistoryLine history={current.history} />
      <ul className="flex flex-col gap-1 text-[12.5px]">
        {order.items.map((item, index) => (
          <li key={index}>
            {item.quantity}× {item.name}
            {item.notes && <div className="text-[11px] text-ink-3 italic">Obs.: {item.notes}</div>}
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
        order.status !== "CANCELED" && <Progress current={current} />
      )}
      {NOTIFIABLE.has(order.status) && !current.stale && (
        <div className="flex justify-end">
          <ForecastButton order={order} conversationId={conversationId} />
        </div>
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

/** Forno: a biblioteca de ícones não tem um. */
function OvenIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 8h18M7 5.500h.01M11 5.500h.01" />
      <rect x="7" y="11.500" width="10" height="6" rx="1" />
    </svg>
  );
}

const STAGE_ICON: Record<StageKey, (props: { className?: string }) => ReactNode> = {
  preparing: OvenIcon,
  waiting: ShoppingBagIcon,
  route: MotorbikeIcon,
  delivered: CheckIcon,
};

/** Uma linha por etapa: símbolo, hora em que começou, barra proporcional ao tempo e a duração. */
function Progress({ current }: { current: CurrentOrderDto }) {
  const now = useNow(30_000);
  const { order, forecast } = current;
  const stages = orderStages(current, now);
  const departed = order.dispatchedAt !== null;
  const awaitingPickup = current.takeout && current.readyAt !== null && order.deliveredAt === null;
  const promised = current.promisedAt ? Date.parse(current.promisedAt) : null;
  const late = !awaitingPickup && !departed && order.status !== "DELIVERED" && (Boolean(forecast?.late) || (promised !== null && now > promised));
  const longest = Math.max(1, ...stages.map((stage) => stage.durationMs ?? 0));
  const delivered = order.deliveredAt ? Date.parse(order.deliveredAt) : null;

  return (
    <div className="flex flex-col gap-2.5">
      <ol className="flex flex-col gap-2" aria-label="Andamento do pedido">
        {stages.map((stage) => {
          const Icon = STAGE_ICON[stage.key];
          const final = stage.key === "delivered";
          const running = stage.state === "current";
          const tone = stage.state === "next" ? "text-ink-3" : running && late ? "text-tomate" : running ? "text-ink" : "text-success";
          const width = final ? (stage.state === "done" ? 100 : 0) : stage.durationMs === null ? 0 : Math.max(3, (stage.durationMs / longest) * 100);
          const duration = final
            ? delivered !== null && `total ${responseTime((delivered - Date.parse(order.placedAt)) / 1000)}`
            : stage.durationMs !== null
              ? `${responseTime(stage.durationMs / 1000)}${running ? " até agora" : ""}`
              : stage.state === "done" && "sem registro";
          return (
            <li key={stage.key} className="grid grid-cols-[24px_minmax(0,1fr)] items-center gap-2" aria-current={running ? "step" : undefined}>
              <span className={cn("flex size-6 items-center justify-center rounded-md bg-surface-2", tone, stage.state === "next" && "opacity-60")}>
                <Icon className="size-3.5" />
              </span>
              <div className="min-w-0">
                <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
                  <span className={cn("truncate", stage.state === "next" ? "text-ink-3" : "font-medium")}>{stage.label}</span>
                  {duration && <span className={cn("shrink-0 tabular-nums", running ? cn("font-semibold", tone) : "text-ink-2")}>{duration}</span>}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span className="w-[34px] shrink-0 text-[10.5px] text-ink-3 tabular-nums">{stage.startedAt ? clock(stage.startedAt) : "--:--"}</span>
                  <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
                    <span className={cn("block h-full rounded-full", running ? (late ? "bg-tomate" : "bg-ink") : "bg-success")} style={{ width: `${width}%` }} />
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px] tabular-nums">
        {!departed && forecast && (
          <>
            <dt className="text-ink-3">Saída prevista</dt>
            <dd className={cn("text-right", forecast.late && "font-medium text-tomate")}>
              {clock(forecast.departAt)}
              {forecast.late && " · atrasado"}
            </dd>
          </>
        )}
        {current.promisedAt && (
          <>
            <dt className="text-ink-3">
              {current.takeout ? "Retirada" : "Entrega"} prometida ({CHANNEL_LABEL[order.channelType]})
            </dt>
            <dd className="text-right">{clock(current.promisedAt)}</dd>
          </>
        )}
        {!departed && !forecast && !awaitingPickup && order.status !== "DELIVERED" && (
          <dd className="col-span-2 text-ink-3">Sem previsão de saída: ainda não há pedidos que saíram para servir de base.</dd>
        )}
      </dl>
    </div>
  );
}
