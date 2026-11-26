import { describe, expect, it } from "vitest";
import {
  aiProgress,
  groupRuleLabel,
  hoursLabel,
  inSlots,
  itemNotes,
  type MenuItem,
  menuCounts,
  moveItem,
  parseCents,
  priceLabel,
  rangesToSlots,
  slotsToRanges,
  storeOpen,
  weeklyMinutes,
} from "@/lib/menu";

const item = (patch: Partial<MenuItem> = {}): MenuItem => ({
  id: "i1",
  categoryId: "c1",
  name: "Calabresa",
  description: null,
  priceCents: 3490,
  photoUrl: "https://x/y.jpg",
  sortOrder: 0,
  active: true,
  soldOut: false,
  allowsHalf: true,
  ingredients: ["calabresa"],
  allergens: [],
  servesPeople: null,
  tags: [],
  synonyms: [],
  aiNotes: null,
  costCents: null,
  promoPriceCents: null,
  sizes: [],
  optionGroups: [],
  availabilities: [],
  pairsWith: [],
  ...patch,
});

describe("menu", () => {
  it("monta o preço e lê o campo de preço", () => {
    expect(priceLabel(item())).toMatch(/34,90/);
    expect(priceLabel(item({ priceCents: null, sizes: [{ id: "a", name: "P", priceCents: 3490, sortOrder: 0, active: true }, { id: "b", name: "G", priceCents: 5690, sortOrder: 1, active: true }] }))).toMatch(/34,90.* a .*56,90/);
    expect(parseCents("34,90")).toBe(3490);
    expect(parseCents("1.234,50")).toBe(123450);
    expect(parseCents("")).toBeNull();
  });

  it("avisa item sem foto e sem ingredientes", () => {
    expect(itemNotes(item()).length).toBe(0);
    expect(itemNotes(item({ photoUrl: null, ingredients: [] })).map((note) => note.kind)).toEqual(["photo", "ia"]);
  });

  it("conta itens, esgotados e o que está visível agora", () => {
    const category = { id: "c1", name: "Pizzas", description: null, sortOrder: 0, active: true, allowsHalf: false, halfPricing: "MAX" as const, availabilities: [], items: [item(), item({ id: "2", soldOut: true }), item({ id: "3", active: false }), item({ id: "4", photoUrl: null })] };
    const counts = menuCounts([category], { weekday: 1, minute: 600 });
    expect(counts).toMatchObject({ items: 3, soldOut: 1, noPhoto: 1, archived: 1, visibleNow: 2 });
  });

  it("faixas de horário, inclusive a que passa da meia-noite", () => {
    const lunch = [{ weekday: 1, startMinute: 660, endMinute: 900 }];
    expect(inSlots(lunch, { weekday: 1, minute: 700 })).toBe(true);
    expect(inSlots(lunch, { weekday: 1, minute: 900 })).toBe(false);
    expect(inSlots(lunch, { weekday: 2, minute: 700 })).toBe(false);
    const night = [{ weekday: 5, startMinute: 1320, endMinute: 120 }];
    expect(inSlots(night, { weekday: 6, minute: 60 })).toBe(true);
    expect(inSlots([], { weekday: 0, minute: 0 })).toBe(true);
  });

  it("converte faixas da API em faixas de vários dias e de volta", () => {
    const slots = [1, 2, 3].map((weekday) => ({ weekday, startMinute: 660, endMinute: 900 }));
    const ranges = slotsToRanges(slots);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ days: [1, 2, 3], from: "11:00", to: "15:00" });
    expect(rangesToSlots(ranges)).toEqual({ slots });
    expect(rangesToSlots([{ key: "x", days: [], from: "11:00", to: "15:00" }])).toHaveProperty("error");
    expect(rangesToSlots([{ key: "x", days: [1], from: "11h", to: "15:00" }])).toHaveProperty("error");
    expect(rangesToSlots([{ key: "x", days: [1], from: "18:00", to: "00:00" }])).toEqual({ slots: [{ weekday: 1, startMinute: 1080, endMinute: 1440 }] });
  });

  it("avisa quando o item nunca cai no horário da loja", () => {
    const store = Array.from({ length: 7 }, () => [{ open: "18:00", close: "23:00" }]);
    expect(storeOpen(store, { weekday: 3, minute: 19 * 60 })).toBe(true);
    const lunchOnly = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 660, endMinute: 900 }));
    expect(weeklyMinutes(lunchOnly, store)).toBe(0);
    expect(hoursLabel(weeklyMinutes([], store))).toBe("Disponível 35 h por semana");
  });

  it("move itens e descreve o grupo", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b"], 0, 5)).toEqual(["a", "b"]);
    expect(groupRuleLabel({ name: "Borda", minSelect: 0, maxSelect: 1 })).toBe("Borda · Opcional · escolha 1");
    expect(groupRuleLabel({ name: "Adicionais", minSelect: 0, maxSelect: 3 })).toBe("Adicionais · Opcional · até 3");
  });

  it("conta os campos da aba Para a IA", () => {
    expect(aiProgress(item())).toEqual({ done: 1, total: 7 });
  });
});
