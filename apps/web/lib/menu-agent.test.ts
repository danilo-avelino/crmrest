import { DEFAULT_MENU_AGENT } from "@dishdesk/shared";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import type { MenuTree } from "./menu";
import { formChanged, formToPayload, groupsOfCategory, linesOfResponse, newSalesRule, rulesCounter, salesRulesError, settingsToForm, simulationBody, simulationError } from "./menu-agent";

const base = settingsToForm(DEFAULT_MENU_AGENT);

describe("Pedidos pela IA: conversão do formulário", () => {
  it("os padrões viram um formulário vazio e voltam como o corpo mínimo", () => {
    expect(base).toEqual({ enabled: true, attendantName: "", houseRules: "", suggestAddons: true, maxSuggestions: "2", salesRules: [], usePairings: true });
    expect(formToPayload(base, 1000)).toEqual({ ok: true, body: { enabled: true, houseRules: "", suggestAddons: true, maxSuggestionsPerConversation: 2, salesRules: [], usePairings: true } });
  });

  it("apara nome e regras", () => {
    const result = formToPayload({ ...base, attendantName: "  Vila ", houseRules: " Sem borda no broto. " }, 1000);
    expect(result).toEqual({
      ok: true,
      body: { enabled: true, attendantName: "Vila", houseRules: "Sem borda no broto.", suggestAddons: true, maxSuggestionsPerConversation: 2, salesRules: [], usePairings: true },
    });
    expect(formToPayload({ ...base, maxSuggestions: "0" }, 1000)).toMatchObject({ ok: true, body: { maxSuggestionsPerConversation: 0 } });
  });

  it("recusa regras longas e nome longo", () => {
    expect(formToPayload({ ...base, houseRules: "x".repeat(1001) }, 1000)).toMatchObject({ ok: false, error: expect.stringContaining("1.000") });
    expect(formToPayload({ ...base, attendantName: "x".repeat(31) }, 1000)).toMatchObject({ ok: false });
  });

  it("contador das regras e detecção de mudança", () => {
    expect(rulesCounter("a".repeat(142), 1000)).toBe("142 de 1.000");
    expect(formChanged(base, DEFAULT_MENU_AGENT)).toBe(false);
    expect(formChanged({ ...base, enabled: false }, DEFAULT_MENU_AGENT)).toBe(true);
    expect(formChanged({ ...base, houseRules: "x" }, DEFAULT_MENU_AGENT)).toBe(true);
    expect(formChanged({ ...base, salesRules: [] }, DEFAULT_MENU_AGENT)).toBe(false);
    const rule = { id: "r", trigger: "AT_END" as const, categoryId: "c", itemIds: [], groupIds: [], pitch: "" };
    expect(formChanged({ ...base, salesRules: [rule] }, DEFAULT_MENU_AGENT)).toBe(true);
  });
});

describe("Venda pela IA: regras por categoria", () => {
  const item = (id: string, groupIds: string[] = []) => ({ id, optionGroups: groupIds.map((groupId, sortOrder) => ({ groupId, sortOrder })) });
  const menu = {
    menu: null,
    categories: [
      { id: "pizzas", name: "Pizzas", items: [item("calabresa", ["borda"])] },
      { id: "burgers", name: "Hambúrgueres", items: [item("x-burger", ["combo", "adicionais"])] },
      { id: "drinks", name: "Bebidas", items: [item("refri")] },
      { id: "desserts", name: "Sobremesas", items: [] },
    ],
    optionGroups: [
      { id: "borda", name: "Borda" },
      { id: "adicionais", name: "Adicionais" },
      { id: "combo", name: "Transformar em Combo" },
    ],
  } as unknown as MenuTree;

  it("complementos que a regra pode oferecer: só os grupos ligados aos itens da categoria", () => {
    expect(groupsOfCategory(menu, "burgers").map((g) => g.id)).toEqual(["adicionais", "combo"]);
    expect(groupsOfCategory(menu, "drinks")).toEqual([]);
  });

  it("atalhos: bebida e sobremesa no fim pela categoria; combo no hambúrguer com o grupo de combo", () => {
    expect(newSalesRule(menu, "drink", "a")).toEqual({ id: "a", trigger: "AT_END", categoryId: "drinks", itemIds: [], groupIds: [], pitch: "" });
    expect(newSalesRule(menu, "dessert", "b")).toMatchObject({ trigger: "AT_END", categoryId: "desserts" });
    expect(newSalesRule(menu, "combo", "c")).toMatchObject({ trigger: "ON_ADD", categoryId: "burgers", groupIds: ["combo"] });
    expect(newSalesRule(menu, "blank", "d")).toMatchObject({ trigger: "ON_ADD", categoryId: "pizzas", itemIds: [], groupIds: [] });
  });

  it("regra ao pedir sem oferta não salva; no fim sem itens vale (mais vendidos)", () => {
    const end = newSalesRule(menu, "drink", "a");
    expect(salesRulesError([end])).toBeNull();
    expect(salesRulesError([end, newSalesRule(menu, "blank", "b")])).toBe("Regra 2: escolha o que a IA oferece ao pedir um item da categoria.");
    expect(formToPayload({ ...base, salesRules: [newSalesRule(menu, "blank", "b")] }, 1000)).toMatchObject({ ok: false });
    expect(formToPayload({ ...base, salesRules: [{ ...end, pitch: "  gelada  " }] }, 1000)).toMatchObject({ ok: true, body: { salesRules: [{ pitch: "gelada" }] } });
  });
});

describe("Pedidos pela IA: conversa de teste", () => {
  it("a requisição leva só as mensagens (sem os avisos) e o carrinho da volta anterior", () => {
    const cart = { status: "DRAFT" as const, deliveryAddress: null, items: [] };
    expect(
      simulationBody(
        [
          { kind: "user", text: "oi" },
          { kind: "assistant", text: "Olá!" },
          { kind: "note", text: "Simulação: ..." },
          { kind: "user", text: "uma calabresa" },
        ],
        cart,
      ),
    ).toEqual({
      messages: [
        { role: "user", text: "oi" },
        { role: "assistant", text: "Olá!" },
        { role: "user", text: "uma calabresa" },
      ],
      cart,
    });
    expect(simulationBody([{ kind: "user", text: "oi" }], null)).toEqual({ messages: [{ role: "user", text: "oi" }] });
    // As ofertas de venda já feitas voltam, para o limite por conversa valer no teste.
    expect(simulationBody([{ kind: "user", text: "oi" }], null, ["combo"])).toEqual({ messages: [{ role: "user", text: "oi" }], salesOffers: ["combo"] });
  });

  it("a resposta vira o balão do agente e os avisos da simulação", () => {
    const lines = linesOfResponse({
      reply: "Pronto!",
      stopped: null,
      handoff: "cliente pediu uma pessoa",
      events: ["IA adicionou 1 Calabresa G"],
      toolCalls: [
        { name: "buscar_cardapio", input: {}, output: {}, isError: false },
        { name: "adicionar_ao_carrinho", input: {}, output: {}, isError: false },
        { name: "buscar_cardapio", input: {}, output: {}, isError: false },
      ],
      cart: null,
      salesOffers: [],
    });
    expect(lines).toEqual([
      { kind: "assistant", text: "Pronto!" },
      { kind: "note", text: "Simulação: a IA consultou buscar_cardapio, adicionar_ao_carrinho" },
      { kind: "note", text: "Simulação: IA adicionou 1 Calabresa G" },
      { kind: "note", text: "Simulação: a IA chamaria a equipe (cliente pediu uma pessoa)" },
    ]);
  });

  it("agente parado não tem balão, só o aviso", () => {
    const lines = linesOfResponse({ reply: null, stopped: "a resposta veio vazia", handoff: null, events: [], toolCalls: [], cart: null, salesOffers: [] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "note", text: expect.stringContaining("a equipe seria chamada") });
  });

  it("erros em português: 503 diz que a IA não está configurada", () => {
    expect(simulationError(new ApiError(503, "x"))).toContain("A IA não está configurada");
    expect(simulationError(new ApiError(429, "Limite de 30 simulações por dia atingido. Volte amanhã."))).toBe("Limite de 30 simulações por dia atingido. Volte amanhã.");
    expect(simulationError(new Error("rede"))).toContain("Não foi possível simular");
  });
});
