import { describe, expect, it } from "vitest";
import { summarize } from "../src/orders/fraud-alert.js";

const order = (id: string, channel: { type: "IFOOD" | "NEEMO" } | "MENU" | null, tenant: { name: string } | null = { name: "Loja" }) =>
  ({
    id,
    tenantId: "t1",
    displayCode: id,
    // Canal que a RLS esconde: o id existe, a relação volta null. Cardápio próprio: sem canal (channelId null).
    channelId: channel === "MENU" ? null : "ch1",
    channel: channel === "MENU" ? null : channel,
    tenant,
    total: { toFixed: () => "10.00" },
    placedAt: new Date("2026-11-14T12:00:00Z"),
    cancellationReason: null,
    importedAt: null,
    fraudMarkedAt: null,
    fraudMarkedBy: null,
    deliveredAt: null,
    dispatchedAt: null,
    canceledAt: new Date("2026-11-14T12:30:00Z"),
    alertDecision: null,
    deliveryAddress: null,
    events: [],
  }) as unknown as Parameters<typeof summarize>[2][number];

describe("summarize (cancelamentos do cliente)", () => {
  it("ignora o pedido cujo canal ou restaurante o contexto não enxerga", () => {
    const result = summarize(5, 3, [order("a", { type: "IFOOD" }), order("b", null), order("c", { type: "NEEMO" }, null)]);
    expect(result.rows.map((row) => row.id)).toEqual(["a"]);
    expect(result.bySource).toEqual([{ channelType: "IFOOD", orders: 1 }]);
    expect(result.canceledCount).toBe(3);
  });

  it("pedido do cardápio próprio (sem canal) entra como Cardápio Dish Desk", () => {
    const result = summarize(2, 2, [order("a", "MENU"), order("b", { type: "IFOOD" })]);
    expect(result.rows.map((row) => [row.id, row.channelType])).toEqual([["a", "MENU"], ["b", "IFOOD"]]);
    expect(result.bySource).toEqual([{ channelType: "MENU", orders: 1 }, { channelType: "IFOOD", orders: 1 }]);
  });
});
