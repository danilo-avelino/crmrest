import { describe, expect, it } from "vitest";
import { timelineSteps } from "@/components/public-checkout/order-tracking";
import type { PublicMenuCategory } from "./public-menu";
import { reorderLines } from "./reorder";

const base = { description: null, photoUrl: null, allowsHalf: true, tags: [], ingredients: [], allergens: [], servesPeople: null, categoryId: "c1" };
const categories = [
  {
    id: "c1",
    name: "Pizzas",
    items: [
      {
        ...base,
        id: "calabresa",
        name: "Calabresa",
        priceCents: null,
        soldOut: false,
        availableNow: true,
        sizes: [{ id: "g", name: "Grande", priceCents: 5000 }],
        optionGroups: [{ id: "og", name: "Adicionais", minSelect: 0, maxSelect: 3, options: [{ id: "bacon", name: "Bacon", priceCents: 300, soldOut: false }] }],
      },
      { ...base, id: "frango", name: "Frango", priceCents: null, soldOut: false, availableNow: true, sizes: [{ id: "g2", name: "Grande", priceCents: 5200 }], optionGroups: [] },
      { ...base, id: "refri", name: "Refri", priceCents: 800, soldOut: true, availableNow: true, sizes: [], optionGroups: [] },
    ],
  },
] as unknown as PublicMenuCategory[];

describe("pedir de novo", () => {
  it("monta as linhas com nomes do cardápio de agora e deixa de fora o que não está à venda", () => {
    const { lines, skipped } = reorderLines(categories, [
      { itemId: "calabresa", sizeId: "g", optionIds: ["bacon", "bacon"], halves: ["frango"], quantity: 2, note: "bem assada" },
      { itemId: "refri", sizeId: null, optionIds: [], halves: [], quantity: 1, note: null },
      { itemId: "sumiu", sizeId: null, optionIds: [], halves: [], quantity: 1, note: null },
    ]);
    expect(skipped).toBe(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      itemId: "calabresa",
      name: "Calabresa",
      sizeName: "Grande",
      half: { id: "frango", name: "Frango" },
      options: { bacon: 2 },
      quantity: 2,
      note: "bem assada",
      unitCents: 5600,
      totalCents: 11200,
      pricedAt: 0,
    });
  });
});

describe("linha do tempo do pedido", () => {
  it("entrega: mostra o caminho todo e marca o que já aconteceu", () => {
    const steps = timelineSteps({ status: "DISPATCHED", mode: "DELIVERY", timeline: [{ code: "PLACED", at: "2026-11-22T20:00:00Z" }, { code: "CONFIRMED", at: "2026-11-22T20:00:00Z" }] });
    expect(steps.map((s) => [s.code, s.done])).toEqual([
      ["PLACED", true],
      ["CONFIRMED", true],
      ["PREPARING", true],
      ["DISPATCHED", true],
      ["DELIVERED", false],
    ]);
  });

  it("retirada troca 'Saiu para entrega' por 'Pronto para retirar'; cancelado mostra só o que aconteceu", () => {
    expect(timelineSteps({ status: "CONFIRMED", mode: "PICKUP", timeline: [] }).map((s) => s.label)).toContain("Pronto para retirar");
    expect(timelineSteps({ status: "CANCELED", mode: "DELIVERY", timeline: [{ code: "PLACED", at: "x" }, { code: "CANCELED", at: "y" }] }).map((s) => s.code)).toEqual(["PLACED", "CANCELED"]);
  });
});
