import type { CurrentOrderDto, OrderDto, OrderListItem } from "@dishdesk/shared";
import { clock, responseTime } from "@/lib/format";

export type StageKey = "preparing" | "waiting" | "route" | "delivered";
export type StageState = "done" | "current" | "next";

export type OrderStage<K extends string = StageKey> = {
  key: K;
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
  return timedStages(stages, Math.max(byStatus, byTime), now);
}

/** Estado e duração de cada etapa: cada uma termina quando começa a próxima que tem hora; a atual, em `now`. */
function timedStages<K extends string>(stages: Pick<OrderStage<K>, "key" | "label" | "startedAt">[], active: number, now: number): OrderStage<K>[] {
  return stages.map((stage, index) => {
    const state: StageState = index < active || stage.key === "delivered" && index === active ? "done" : index === active ? "current" : "next";
    const start = stage.startedAt ? Date.parse(stage.startedAt) : null;
    const nextStart = stages.slice(index + 1).find((later) => later.startedAt)?.startedAt;
    const end = state === "current" ? now : nextStart ? Date.parse(nextStart) : null;
    const durationMs = stage.key !== "delivered" && state !== "next" && start !== null && end !== null ? Math.max(0, end - start) : null;
    return { ...stage, state, durationMs };
  });
}

export type ListStageKey = "confirming" | StageKey;

/** Etapa de cada status no andamento do modal do pedido (a retirada não tem "Em rota"). */
const LIST_STATUS_STAGE: Partial<Record<OrderDto["status"], ListStageKey>> = {
  PLACED: "confirming",
  CONFIRMED: "preparing",
  PREPARING: "preparing",
  READY: "waiting",
  DISPATCHED: "route",
  DELIVERED: "delivered",
};

/**
 * Andamento do pedido no modal (Inbox → Em produção e aba Pedidos): todas as etapas com a duração de cada uma, pelas
 * horas que a plataforma informou, e o tempo total: até a entrega, até o cancelamento ou, em andamento, até agora.
 */
export function orderListStages(order: OrderListItem, now: number): { stages: OrderStage<ListStageKey>[]; totalMs: number | null; end: "delivered" | "canceled" | "running" } {
  const at = (...codes: string[]) => order.events.find((event) => codes.includes(event.code))?.occurredAt ?? null;
  const confirmedAt = at("CONFIRMED");
  const deliveredAt = order.deliveredAt ?? at("DELIVERED", "DELIVERY_DROP_CODE_VALIDATION_SUCCESS", "CONCLUDED");
  const stages: Pick<OrderStage<ListStageKey>, "key" | "label" | "startedAt">[] = [
    { key: "confirming", label: "Confirmação", startedAt: order.placedAt },
    { key: "preparing", label: "Preparo", startedAt: confirmedAt ?? at("PREPARATION_STARTED") },
    { key: "waiting", label: order.takeout ? "Aguardando retirada" : "Aguardando entrega", startedAt: at("READY_TO_PICKUP") },
    ...(order.takeout ? [] : [{ key: "route" as const, label: "Em rota", startedAt: order.dispatchedAt ?? at("DISPATCHED", "COLLECTED") }]),
    { key: "delivered", label: order.takeout ? "Retirado" : "Entregue", startedAt: deliveredAt },
  ];
  const canceledAt = order.status === "CANCELED" ? at("CANCELLED") : null;
  const statusStage = LIST_STATUS_STAGE[order.status];
  const byStatus = stages.findIndex((stage) => stage.key === (order.takeout && statusStage === "route" ? "waiting" : statusStage));
  const byTime = stages.reduce((latest, stage, index) => (stage.startedAt ? index : latest), 0);
  const end = deliveredAt || order.status === "DELIVERED" ? "delivered" : order.status === "CANCELED" ? "canceled" : "running";
  const stop = end === "delivered" ? (deliveredAt ? Date.parse(deliveredAt) : null) : end === "canceled" ? (canceledAt ? Date.parse(canceledAt) : null) : now;
  const totalMs = stop === null ? null : Math.max(0, stop - Date.parse(order.placedAt));
  const timed = timedStages(stages, Math.max(byStatus, byTime), stop ?? now);
  // Cancelado: a etapa em que parou termina no cancelamento (sem "até agora").
  return { stages: end === "canceled" ? timed.map((stage) => (stage.state === "current" ? { ...stage, state: "done" as const, durationMs: stop === null ? null : stage.durationMs } : stage)) : timed, totalMs, end };
}

/** Parte da etapa atual já percorrida (0 a 1), pelo tempo até a saída prevista ou a entrega prometida; sem esse alvo, o meio. */
export function stageProgress(current: CurrentOrderDto, stage: OrderStage<string>, now: number): number {
  const start = stage.startedAt ? Date.parse(stage.startedAt) : null;
  const target = (stage.key === "route" ? null : current.forecast?.departAt) ?? current.promisedAt;
  const end = target ? Date.parse(target) : null;
  if (start === null || end === null || end <= start) return 0.5;
  return Math.min(0.96, Math.max(0.04, (now - start) / (end - start)));
}

/** O que a dica de cada parte da trilha diz: quanto a etapa durou, ou por que não há esse tempo. */
export function stageHint(stage: OrderStage<string>): string {
  if (stage.key === "delivered") return stage.startedAt ? `às ${clock(stage.startedAt)}` : stage.state === "done" ? "sem registro" : "ainda não aconteceu";
  if (stage.state === "next") return "ainda não começou";
  if (stage.durationMs === null) return "sem registro";
  return `${responseTime(stage.durationMs / 1000)}${stage.state === "current" ? " até agora" : ""}`;
}

/** Quanto falta para a hora prevista ou, se ela já passou, há quanto tempo está atrasado. */
export function promiseCountdown(promisedAt: string, now: number): { text: string; late: boolean } {
  const difference = Date.parse(promisedAt) - now;
  const time = responseTime(Math.max(60, Math.abs(difference) / 1000));
  return difference < 0 ? { text: `atrasado há ${time}`, late: true } : { text: `faltam ${time}`, late: false };
}
