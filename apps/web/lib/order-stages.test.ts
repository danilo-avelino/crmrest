import type { CurrentOrderDto, OrderListItem } from "@dishdesk/shared";
import { describe, expect, it } from "vitest";
import { orderListStages, orderStages, promiseCountdown, stageHint, stageProgress } from "./order-stages";

const MINUTE = 60_000;
const start = Date.parse("2026-11-18T15:00:00.000Z");
const at = (minutes: number) => new Date(start + minutes * MINUTE).toISOString();

function current(order: Partial<CurrentOrderDto["order"]>, patch: Partial<CurrentOrderDto> = {}): CurrentOrderDto {
  return {
    order: { status: "PREPARING", placedAt: at(0), dispatchedAt: null, deliveredAt: null, ...order },
    startedAt: at(2),
    readyAt: null,
    takeout: false,
    promisedAt: null,
    forecast: null,
    ...patch,
  } as CurrentOrderDto;
}

const summary = (data: CurrentOrderDto, now: number) =>
  orderStages(data, start + now * MINUTE).map((stage) => [stage.key, stage.state, stage.durationMs === null ? null : stage.durationMs / MINUTE]);

describe("etapas do pedido", () => {
  it("conta a etapa atual até agora", () => {
    expect(summary(current({}), 12)).toEqual([
      ["preparing", "current", 10],
      ["waiting", "next", null],
      ["route", "next", null],
      ["delivered", "next", null],
    ]);
  });

  it("mostra quanto durou cada etapa do pedido entregue", () => {
    const data = current({ status: "DELIVERED", dispatchedAt: at(25), deliveredAt: at(40) }, { readyAt: at(20) });
    expect(summary(data, 60)).toEqual([
      ["preparing", "done", 18],
      ["waiting", "done", 5],
      ["route", "done", 15],
      ["delivered", "done", null],
    ]);
  });

  it("sem a hora do pronto, o preparo vai até a saída e a espera fica sem registro", () => {
    const data = current({ status: "DISPATCHED", dispatchedAt: at(30) });
    expect(summary(data, 35)).toEqual([
      ["preparing", "done", 28],
      ["waiting", "done", null],
      ["route", "current", 5],
      ["delivered", "next", null],
    ]);
  });

  it("usa a hora informada quando ela está à frente do status", () => {
    expect(summary(current({ status: "PREPARING" }, { readyAt: at(9) }), 15)[1]).toEqual(["waiting", "current", 6]);
  });

  it("retirada não tem a etapa em rota", () => {
    const stages = orderStages(current({ status: "READY" }, { takeout: true, readyAt: at(10) }), start + 14 * MINUTE);
    expect(stages.map((stage) => stage.label)).toEqual(["Preparo", "Aguardando retirada", "Retirado"]);
    expect(stages[1]).toMatchObject({ state: "current", durationMs: 4 * MINUTE });
  });

  it("anda na etapa atual até a saída prevista", () => {
    const data = current({}, { forecast: { departAt: at(22), late: false, ahead: 0 } });
    const now = start + 12 * MINUTE;
    expect(stageProgress(data, orderStages(data, now)[0]!, now)).toBeCloseTo(0.5);
  });

  it("em rota, anda até a entrega prometida e não chega ao fim antes de entregar", () => {
    const data = current({ status: "DISPATCHED", dispatchedAt: at(10) }, { promisedAt: at(20) });
    const now = start + 40 * MINUTE;
    expect(stageProgress(data, orderStages(data, now)[2]!, now)).toBe(0.96);
  });

  it("a dica diz quanto cada etapa durou", () => {
    const data = current({ status: "DISPATCHED", dispatchedAt: at(30) });
    expect(orderStages(data, start + 35 * MINUTE).map(stageHint)).toEqual(["28 min", "sem registro", "5 min até agora", "ainda não aconteceu"]);
    expect(orderStages(current({}), start + 5 * MINUTE).map(stageHint).slice(0, 2)).toEqual(["3 min até agora", "ainda não começou"]);
  });

  it("conta o tempo até a previsão de entrega e o atraso depois dela", () => {
    expect(promiseCountdown(at(30), start + 18 * MINUTE)).toEqual({ text: "faltam 12 min", late: false });
    expect(promiseCountdown(at(30), start + 35 * MINUTE)).toEqual({ text: "atrasado há 5 min", late: true });
    expect(promiseCountdown(at(30), start + 30 * MINUTE)).toEqual({ text: "faltam 1 min", late: false });
  });

  it("sem previsão nem promessa, fica no meio da etapa", () => {
    const data = current({});
    const now = start + 12 * MINUTE;
    expect(stageProgress(data, orderStages(data, now)[0]!, now)).toBe(0.5);
  });
});

describe("andamento do pedido no modal", () => {
  const ev = (code: string, minutes: number) => ({ code, occurredAt: at(minutes), detail: null });
  const item = (patch: Partial<OrderListItem>): OrderListItem =>
    ({ status: "PREPARING", placedAt: at(0), dispatchedAt: null, deliveredAt: null, takeout: false, events: [], ...patch }) as OrderListItem;
  const view = (order: OrderListItem, now: number) => {
    const result = orderListStages(order, start + now * MINUTE);
    return { stages: result.stages.map(stageHint), total: result.totalMs === null ? null : result.totalMs / MINUTE, end: result.end };
  };

  it("em andamento: cada etapa com a duração e o total até agora", () => {
    const order = item({ status: "READY", events: [ev("PLACED", 0), ev("CONFIRMED", 1), ev("READY_TO_PICKUP", 12)] });
    expect(view(order, 20)).toEqual({ stages: ["1 min", "11 min", "8 min até agora", "ainda não começou", "ainda não aconteceu"], total: 20, end: "running" });
  });

  it("entregue: o total vai até a entrega", () => {
    const order = item({ status: "DELIVERED", dispatchedAt: at(15), deliveredAt: at(40), events: [ev("CONFIRMED", 2), ev("READY_TO_PICKUP", 10)] });
    const result = view(order, 90);
    expect(result.total).toBe(40);
    expect(result.end).toBe("delivered");
    expect(result.stages[3]).toBe("25 min");
  });

  it("cancelado: para no cancelamento", () => {
    const order = item({ status: "CANCELED", events: [ev("CONFIRMED", 2), ev("CANCELLED", 9)] });
    expect(view(order, 60)).toMatchObject({ total: 9, end: "canceled", stages: ["2 min", "7 min", "ainda não começou", "ainda não começou", "ainda não aconteceu"] });
  });
});
