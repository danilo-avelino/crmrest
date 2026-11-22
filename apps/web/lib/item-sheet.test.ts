import { describe, expect, it } from "vitest";
import {
  buttonView,
  emptySelection,
  flavorPickable,
  flavorPrice,
  groupBadge,
  groupErrors,
  groupHint,
  groupKind,
  halfCandidates,
  halfRuleText,
  type ItemSelection,
  missingChoice,
  type PriceResponse,
  priceRequestOf,
  requestKey,
  stepOption,
  toggleOption,
} from "./item-sheet";
import type { PublicMenuCategory, PublicMenuItem } from "./public-menu";

type Group = PublicMenuItem["optionGroups"][number];

function item(over: Partial<PublicMenuItem> = {}): PublicMenuItem {
  return {
    id: "pizza",
    categoryId: "c",
    name: "Calabresa",
    description: null,
    priceCents: null,
    photoUrl: null,
    soldOut: false,
    availableNow: true,
    allowsHalf: true,
    sizes: [
      { id: "broto", name: "Broto", priceCents: 3490 },
      { id: "grande", name: "Grande", priceCents: 5690 },
    ],
    optionGroups: [],
    tags: [],
    ingredients: [],
    allergens: [],
    servesPeople: null,
    ...over,
  };
}

const group = (over: Partial<Group> = {}): Group => ({
  id: "g",
  name: "Adicionais",
  minSelect: 0,
  maxSelect: 3,
  options: [
    { id: "a", name: "Bacon", priceCents: 400, soldOut: false },
    { id: "b", name: "Cebola", priceCents: 300, soldOut: false },
    { id: "c", name: "Azeitona", priceCents: 200, soldOut: false },
    { id: "d", name: "Catupiry", priceCents: 500, soldOut: true },
  ],
  ...over,
});

const sel = (over: Partial<ItemSelection> = {}): ItemSelection => ({ ...emptySelection(item()), ...over });

describe("priceRequestOf", () => {
  it("monta o corpo do POST price: unidades viram ids repetidos, metade só com o meio a meio ligado", () => {
    expect(priceRequestOf(sel({ sizeId: "grande", options: { a: 1, x: 2 }, quantity: 2, halfMode: true, halfId: "diavola" }))).toEqual({
      itemId: "pizza",
      sizeId: "grande",
      halves: ["diavola"],
      optionIds: ["a", "x", "x"],
      quantity: 2,
    });
    expect(priceRequestOf(sel({ halfMode: false, halfId: "diavola" })).halves).toEqual([]);
  });

  it("a chave não depende da ordem dos complementos", () => {
    const a = priceRequestOf(sel({ options: { a: 1, b: 1 } }));
    const b = priceRequestOf(sel({ options: { b: 1, a: 1 } }));
    expect(requestKey(a)).toBe(requestKey(b));
    expect(requestKey(a)).not.toBe(requestKey(priceRequestOf(sel({ options: { a: 1 } }))));
  });
});

describe("emptySelection e missingChoice", () => {
  it("vários tamanhos: nenhum marcado e o botão pede o tamanho (R6)", () => {
    expect(emptySelection(item()).sizeId).toBeNull();
    expect(missingChoice(item(), emptySelection(item()))).toBe("size");
  });
  it("um tamanho só já vem marcado; sem tamanhos não falta nada", () => {
    const one = item({ sizes: [{ id: "u", name: "Único", priceCents: 1000 }] });
    expect(emptySelection(one).sizeId).toBe("u");
    const drink = item({ sizes: [], priceCents: 1400 });
    expect(missingChoice(drink, emptySelection(drink))).toBeNull();
  });
  it("meio a meio sem a 2ª metade", () => {
    expect(missingChoice(item(), sel({ sizeId: "grande", halfMode: true }))).toBe("half");
  });
});

describe("buttonView", () => {
  const ok: PriceResponse = {
    ok: true,
    line: { itemId: "pizza", sizeId: "grande", halves: [], halfRule: null, baseCents: 5690, options: [], optionsCents: 0, unitCents: 5690, quantity: 1, totalCents: 5690 },
    button: { disabled: false, label: "Adicionar R$ 56,90", totalCents: 5690 },
  };
  it("nunca R$ 0,00: sem tamanho ou sem resposta, o botão diz o que falta", () => {
    expect(buttonView("size", ok, "Adicionar").label).toBe("Escolha o tamanho");
    expect(buttonView("half", ok, "Adicionar").label).toBe("Escolha a 2ª metade");
    expect(buttonView(null, null, "Adicionar")).toEqual({ label: "Adicionar", tone: "blocked", totalCents: null });
  });
  it("com o preço da API: Adicionar ou Atualizar com o total", () => {
    expect(buttonView(null, ok, "Adicionar").label.replace(/\s/g, " ")).toBe("Adicionar · R$ 56,90");
    expect(buttonView(null, ok, "Atualizar").label.replace(/\s/g, " ")).toBe("Atualizar · R$ 56,90");
  });
  it("erro da API: o motivo, sem o ponto final", () => {
    const fail: PriceResponse = {
      ok: false,
      errors: [{ code: "GROUP_MIN", message: "Escolha pelo menos 1 em Borda.", groupId: "g" }],
      button: { disabled: true, label: "Escolha pelo menos 1 em Borda.", code: "GROUP_MIN" },
    };
    expect(buttonView(null, fail, "Adicionar")).toEqual({ label: "Escolha pelo menos 1 em Borda", tone: "blocked", totalCents: null });
  });
});

describe("grupos", () => {
  it("rótulos: Obrigatório, Opcional · até N e Opcional", () => {
    expect(groupBadge(group({ minSelect: 1, maxSelect: 1 }))).toBe("Obrigatório");
    expect(groupBadge(group())).toBe("Opcional · até 3");
    expect(groupBadge(group({ maxSelect: 1 }))).toBe("Opcional");
  });
  it("tipo: rádio, caixa ou quantidade (combo com mínimo igual ao máximo)", () => {
    expect(groupKind(group({ maxSelect: 1 }))).toBe("single");
    expect(groupKind(group())).toBe("multi");
    expect(groupKind(group({ minSelect: 3, maxSelect: 3 }))).toBe("count");
  });
  it("caixa não passa do máximo e não marca opção em falta", () => {
    const g = group({ maxSelect: 2 });
    let s = toggleOption(g, sel(), "a");
    s = toggleOption(g, s, "b");
    expect(toggleOption(g, s, "c")).toBe(s);
    expect(toggleOption(g, sel(), "d")).toEqual(sel());
    expect(toggleOption(g, s, "a").options).toEqual({ b: 1 });
  });
  it("rádio opcional desmarca no 2º toque; obrigatório não", () => {
    const optional = group({ maxSelect: 1 });
    const once = toggleOption(optional, sel(), "a");
    expect(toggleOption(optional, once, "b").options).toEqual({ b: 1 });
    expect(toggleOption(optional, once, "a").options).toEqual({});
    const required = group({ minSelect: 1, maxSelect: 1 });
    expect(toggleOption(required, toggleOption(required, sel(), "a"), "a").options).toEqual({ a: 1 });
  });
  it("combo: stepper repete a opção até o máximo do grupo", () => {
    const g = group({ minSelect: 3, maxSelect: 3 });
    let s = sel();
    for (let i = 0; i < 5; i++) s = stepOption(g, s, "a", 1);
    expect(s.options).toEqual({ a: 3 });
    expect(stepOption(g, sel(), "d", 1)).toEqual(sel());
    expect(groupHint(g, s)).toEqual({ text: "3 de 3 · completo", complete: true });
    expect(stepOption(g, s, "a", -1).options).toEqual({ a: 2 });
  });
  it("erros de mínimo e máximo por grupo", () => {
    const it1 = item({ optionGroups: [group({ id: "borda", name: "Borda", minSelect: 1, maxSelect: 1, options: [{ id: "z", name: "Catupiry", priceCents: 590, soldOut: false }] }), group({ id: "x", maxSelect: 1 })] });
    expect(groupErrors(it1, sel({ options: { a: 1, b: 1 } }))).toEqual({ borda: "Escolha 1 opção em Borda", x: "Escolha até 1 em Adicionais" });
    expect(groupHint(group(), sel({ options: { a: 1 } })).text).toBe("1 de 3 escolhidos");
  });
});

describe("meio a meio", () => {
  const diavola = item({ id: "diavola", name: "Diavola", sizes: [{ id: "dg", name: "grande", priceCents: 6290 }] });
  const atum = item({ id: "atum", name: "Atum", soldOut: true });
  const outra = item({ id: "outra", name: "Inteira só", allowsHalf: false });
  const category: PublicMenuCategory = {
    id: "c",
    name: "Pizzas",
    description: null,
    allowsHalf: true,
    halfPricing: "SUM",
    availableNow: true,
    items: [item(), diavola, atum, outra],
  };
  it("sabores da mesma categoria que aceitam meio a meio, sem o próprio item", () => {
    expect(halfCandidates(item(), category).map((c) => c.id)).toEqual(["diavola", "atum"]);
    expect(halfCandidates(item(), { ...category, allowsHalf: false })).toEqual([]);
  });
  it("preço do sabor no tamanho pelo nome (como a API); sem o tamanho, não dá para escolher", () => {
    expect(flavorPrice(diavola, "Grande")).toBe(6290);
    expect(flavorPrice(diavola, "Broto")).toBeNull();
    expect(flavorPrice(item(), null)).toBe(3490);
    expect(flavorPickable(diavola, "Broto")).toBe(false);
    expect(flavorPickable(atum, "Grande")).toBe(false);
  });
  it("regra escrita no modal (R7)", () => {
    expect(halfRuleText("SUM")).toBe("O preço é a soma das duas metades.");
    expect(halfRuleText("MAX")).toBe("O preço é o da metade mais cara.");
    expect(halfRuleText("AVERAGE")).toBe("O preço é a média das duas metades.");
  });
});
