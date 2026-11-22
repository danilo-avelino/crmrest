import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type { PricedLine } from "./item-sheet";
import {
  addLine,
  type CartLine,
  CartProvider,
  cartSummary,
  lineOf,
  loadCart,
  removeLine,
  resetCartMemory,
  saveCart,
  selectionOfLine,
  storageKey,
  updateLine,
  useCart,
} from "./public-cart";

const priced: PricedLine = {
  itemId: "pizza",
  sizeId: "grande",
  halves: ["diavola"],
  halfRule: "SUM",
  baseCents: 11980,
  options: [{ id: "bacon", groupId: "g", name: "Bacon", priceCents: 400 }],
  optionsCents: 400,
  unitCents: 12380,
  quantity: 2,
  totalCents: 24760,
};

const line = (over: Partial<CartLine> = {}): CartLine => ({
  ...lineOf(
    {
      id: "l1",
      name: "Calabresa",
      sizeName: "Grande",
      halfName: "Diavola",
      selection: { itemId: "pizza", sizeId: "grande", halfMode: true, halfId: "diavola", options: { bacon: 1 }, quantity: 2, note: "  sem cebola " },
      priced,
    },
    1000,
  ),
  ...over,
});

describe("linha da sacola", () => {
  it("guarda a escolha e o retrato do preço da API", () => {
    expect(line()).toEqual({
      id: "l1",
      itemId: "pizza",
      name: "Calabresa",
      sizeId: "grande",
      sizeName: "Grande",
      half: { id: "diavola", name: "Diavola" },
      options: { bacon: 1 },
      optionLines: [{ id: "bacon", name: "Bacon", priceCents: 400 }],
      quantity: 2,
      note: "sem cebola",
      unitCents: 12380,
      totalCents: 24760,
      pricedAt: 1000,
    });
  });
  it("volta para a escolha da ficha (editar)", () => {
    expect(selectionOfLine(line())).toEqual({ itemId: "pizza", sizeId: "grande", halfMode: true, halfId: "diavola", options: { bacon: 1 }, quantity: 2, note: "sem cebola" });
  });
  it("adiciona, atualiza pelo id, remove e soma", () => {
    let lines = addLine([], line());
    lines = addLine(lines, line({ id: "l2", quantity: 1, totalCents: 1400 }));
    lines = updateLine(lines, line({ quantity: 1, totalCents: 12380 }));
    expect(lines.map((l) => [l.id, l.quantity])).toEqual([
      ["l1", 1],
      ["l2", 1],
    ]);
    expect(cartSummary(lines)).toEqual({ count: 2, subtotalCents: 13780 });
    expect(removeLine(lines, "l1").map((l) => l.id)).toEqual(["l2"]);
    expect(updateLine([], line()).map((l) => l.id)).toEqual(["l1"]);
  });
});

describe("armazenamento por loja", () => {
  beforeEach(() => {
    localStorage.clear();
    resetCartMemory();
  });

  it("salva e lê por slug; outra loja tem outra sacola", () => {
    saveCart("forno", [line()]);
    expect(loadCart("forno")).toEqual([line()]);
    expect(loadCart("outra")).toEqual([]);
    saveCart("forno", []);
    expect(localStorage.getItem(storageKey("forno"))).toBeNull();
  });
  it("conteúdo estragado ou armazenamento bloqueado: sacola vazia, sem erro", () => {
    localStorage.setItem(storageKey("forno"), "{nada");
    expect(loadCart("forno")).toEqual([]);
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
      removeItem: () => {},
    };
    expect(loadCart("forno", blocked)).toEqual([]);
    expect(() => saveCart("forno", [line()], blocked)).not.toThrow();
  });
  it("CartProvider lê a sacola salva e grava cada mudança", () => {
    saveCart("forno", [line()]);
    const wrapper = ({ children }: { children: ReactNode }) => createElement(CartProvider, { slug: "forno" }, children);
    const { result } = renderHook(() => useCart(), { wrapper });
    expect(result.current.lines.map((l) => l.id)).toEqual(["l1"]);
    act(() => result.current.add(line({ id: "l2" })));
    act(() => result.current.update(line({ id: "l1", quantity: 5 })));
    expect(loadCart("forno").map((l) => [l.id, l.quantity])).toEqual([
      ["l1", 5],
      ["l2", 2],
    ]);
    act(() => result.current.remove("l1"));
    expect(loadCart("forno").map((l) => l.id)).toEqual(["l2"]);
  });
});
