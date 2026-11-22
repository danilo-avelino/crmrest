import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceRequest } from "@/lib/item-sheet";
import { CartProvider, loadCart, resetCartMemory } from "@/lib/public-cart";
import type { PublicMenuCategory, PublicMenuItem } from "@/lib/public-menu";
import { ItemSheet } from "./item-sheet";

const pizza: PublicMenuItem = {
  id: "pizza",
  categoryId: "c",
  name: "Calabresa",
  description: null,
  priceCents: null,
  photoUrl: null,
  soldOut: false,
  availableNow: true,
  allowsHalf: false,
  sizes: [
    { id: "broto", name: "Broto", priceCents: 3490 },
    { id: "grande", name: "Grande", priceCents: 5690 },
  ],
  optionGroups: [
    {
      id: "borda",
      name: "Borda",
      minSelect: 1,
      maxSelect: 1,
      options: [
        { id: "sem", name: "Sem borda", priceCents: 0, soldOut: false },
        { id: "cat", name: "Catupiry", priceCents: 590, soldOut: false },
      ],
    },
  ],
  tags: [],
  ingredients: [],
  allergens: [],
  servesPeople: null,
};
const category: PublicMenuCategory = { id: "c", name: "Pizzas", description: null, allowsHalf: false, halfPricing: "SUM", availableNow: true, items: [pizza] };

/** API falsa: soma tamanho + borda, e GROUP_MIN sem borda (a conta real é do PricingService). */
function fakeApi() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as PriceRequest;
    const size = pizza.sizes.find((s) => s.id === body.sizeId)!;
    const border = pizza.optionGroups[0]!.options.find((o) => body.optionIds.includes(o.id));
    const button = { disabled: true, label: "x", code: "GROUP_MIN" };
    const json = border
      ? {
          ok: true,
          line: {
            itemId: "pizza",
            sizeId: size.id,
            halves: [],
            halfRule: null,
            baseCents: size.priceCents,
            options: [{ id: border.id, groupId: "borda", name: border.name, priceCents: border.priceCents }],
            optionsCents: border.priceCents,
            unitCents: size.priceCents + border.priceCents,
            quantity: body.quantity,
            totalCents: (size.priceCents + border.priceCents) * body.quantity,
          },
          button: { disabled: false, label: "", totalCents: 0 },
        }
      : { ok: false, errors: [{ code: "GROUP_MIN", message: "Escolha pelo menos 1 em Borda.", groupId: "borda" }], button };
    return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

const wrap = (children: ReactNode) => <CartProvider slug="forno">{children}</CartProvider>;
const mainButton = () => screen.getAllByRole("button").at(-1)!;
const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
};

describe("ItemSheet", () => {
  let api: ReturnType<typeof fakeApi>;
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetCartMemory();
    api = fakeApi();
    vi.stubGlobal("fetch", api);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sem tamanho: 'Escolha o tamanho', sem pedir preço; tocar mostra o erro no grupo (R6)", async () => {
    render(wrap(<ItemSheet slug="forno" item={pizza} category={category} onClose={() => {}} />));
    expect(mainButton().textContent).toBe("Escolha o tamanho");
    expect(document.body.textContent).not.toContain("R$ 0,00");
    await flush();
    expect(api).not.toHaveBeenCalled();
    fireEvent.click(mainButton());
    expect(screen.getByText("Escolha o tamanho para continuar")).toBeTruthy();
  });

  it("o total vem da API, muda a cada escolha, e Adicionar põe a linha na sacola e fecha", async () => {
    const onClose = vi.fn();
    render(wrap(<ItemSheet slug="forno" item={pizza} category={category} onClose={onClose} />));
    fireEvent.click(screen.getByRole("radio", { name: /Grande/ }));
    await flush();
    expect(mainButton().textContent).toBe("Escolha pelo menos 1 em Borda");
    fireEvent.click(screen.getByRole("radio", { name: /Catupiry/ }));
    await flush();
    expect(mainButton().textContent?.replace(/\s/g, " ")).toBe("Adicionar · R$ 62,80");
    fireEvent.click(screen.getByRole("button", { name: "Mais quantidade" }));
    await flush();
    expect(mainButton().textContent?.replace(/\s/g, " ")).toBe("Adicionar · R$ 125,60");
    const [url, init] = api.mock.calls.at(-1)!;
    expect(url).toBe("/api/public/menu/forno/price");
    expect(JSON.parse(init.body as string)).toEqual({ itemId: "pizza", sizeId: "grande", halves: [], optionIds: ["cat"], quantity: 2 });

    await act(async () => {
      fireEvent.click(mainButton());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onClose).toHaveBeenCalled();
    expect(loadCart("forno").map((l) => [l.itemId, l.sizeName, l.quantity, l.totalCents])).toEqual([["pizza", "Grande", 2, 12560]]);
  });

  it("editar: abre com a linha e o botão diz Atualizar", async () => {
    const editing = {
      id: "l1",
      itemId: "pizza",
      name: "Calabresa",
      sizeId: "broto",
      sizeName: "Broto",
      half: null,
      options: { sem: 1 },
      optionLines: [],
      quantity: 1,
      note: null,
      unitCents: 3490,
      totalCents: 3490,
      pricedAt: 0,
    };
    render(wrap(<ItemSheet slug="forno" item={pizza} category={category} editing={editing} onClose={() => {}} />));
    await flush();
    expect(mainButton().textContent?.replace(/\s/g, " ")).toBe("Atualizar · R$ 34,90");
    expect(screen.getByRole("radio", { name: /Broto/ }).getAttribute("aria-checked")).toBe("true");
  });
});
