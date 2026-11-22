import { DEFAULT_MENU_AGENT } from "@dishdesk/shared";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { formChanged, formToPayload, linesOfResponse, rulesCounter, settingsToForm, simulationBody, simulationError } from "./menu-agent";

const base = settingsToForm(DEFAULT_MENU_AGENT);

describe("Pedidos pela IA: conversão do formulário", () => {
  it("os padrões viram um formulário vazio e voltam como o corpo mínimo", () => {
    expect(base).toEqual({ enabled: true, attendantName: "", houseRules: "", suggestAddons: true, maxSuggestions: "2", dailyTokens: "" });
    expect(formToPayload(base, 1000)).toEqual({ ok: true, body: { enabled: true, houseRules: "", suggestAddons: true, maxSuggestionsPerConversation: 2 } });
  });

  it("apara nome e regras; teto com ponto de milhar vira número", () => {
    const result = formToPayload({ ...base, attendantName: "  Vila ", houseRules: " Sem borda no broto. ", dailyTokens: "50.000" }, 1000);
    expect(result).toEqual({ ok: true, body: { enabled: true, attendantName: "Vila", houseRules: "Sem borda no broto.", suggestAddons: true, maxSuggestionsPerConversation: 2, dailyTokensPerConversation: 50_000 } });
    expect(formToPayload({ ...base, maxSuggestions: "0" }, 1000)).toMatchObject({ ok: true, body: { maxSuggestionsPerConversation: 0 } });
  });

  it("o teto salvo aparece com milhar", () => {
    expect(settingsToForm({ ...DEFAULT_MENU_AGENT, dailyTokensPerConversation: 400_000 }).dailyTokens).toBe("400.000");
  });

  it("recusa regras longas, nome longo e teto fora da faixa ou com letras", () => {
    expect(formToPayload({ ...base, houseRules: "x".repeat(1001) }, 1000)).toMatchObject({ ok: false, error: expect.stringContaining("1.000") });
    expect(formToPayload({ ...base, attendantName: "x".repeat(31) }, 1000)).toMatchObject({ ok: false });
    expect(formToPayload({ ...base, dailyTokens: "500" }, 1000)).toMatchObject({ ok: false });
    expect(formToPayload({ ...base, dailyTokens: "3.000.000" }, 1000)).toMatchObject({ ok: false });
    expect(formToPayload({ ...base, dailyTokens: "muito" }, 1000)).toMatchObject({ ok: false });
  });

  it("contador das regras e detecção de mudança", () => {
    expect(rulesCounter("a".repeat(142), 1000)).toBe("142 de 1.000");
    expect(formChanged(base, DEFAULT_MENU_AGENT)).toBe(false);
    expect(formChanged({ ...base, enabled: false }, DEFAULT_MENU_AGENT)).toBe(true);
    expect(formChanged({ ...base, houseRules: "x" }, DEFAULT_MENU_AGENT)).toBe(true);
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
    });
    expect(lines).toEqual([
      { kind: "assistant", text: "Pronto!" },
      { kind: "note", text: "Simulação: a IA consultou buscar_cardapio, adicionar_ao_carrinho" },
      { kind: "note", text: "Simulação: IA adicionou 1 Calabresa G" },
      { kind: "note", text: "Simulação: a IA chamaria a equipe (cliente pediu uma pessoa)" },
    ]);
  });

  it("agente parado não tem balão, só o aviso", () => {
    const lines = linesOfResponse({ reply: null, stopped: "a resposta veio vazia", handoff: null, events: [], toolCalls: [], cart: null });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "note", text: expect.stringContaining("a equipe seria chamada") });
  });

  it("erros em português: 503 diz que a IA não está configurada", () => {
    expect(simulationError(new ApiError(503, "x"))).toContain("A IA não está configurada");
    expect(simulationError(new ApiError(429, "Limite de 30 simulações por dia atingido. Volte amanhã."))).toBe("Limite de 30 simulações por dia atingido. Volte amanhã.");
    expect(simulationError(new Error("rede"))).toContain("Não foi possível simular");
  });
});
