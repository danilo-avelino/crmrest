import { describe, expect, it } from "vitest";
import { AUTOMATION_TEXT_DEFAULTS, automationTextsOf, type BusinessHours, isOpenAt, menuMessage } from "../src/settings.js";

// Horários de Brasília (-03:00). 2026-10-05 é segunda-feira.
const at = (iso: string) => new Date(`${iso}-03:00`);
const closed = null;

describe("mensagens automáticas", () => {
  it("saudação com e sem o nome do cliente, sempre com as opções do menu", () => {
    expect(menuMessage(AUTOMATION_TEXT_DEFAULTS.greeting, "Maria")).toBe(
      "Olá, Maria! 👋 Em que podemos ajudar?\n1 - Falar sobre um pedido\n2 - Fazer um pedido\n3 - Outro assunto",
    );
    expect(menuMessage(AUTOMATION_TEXT_DEFAULTS.greeting).split("\n")[0]).toBe("Olá! 👋 Em que podemos ajudar?");
    expect(menuMessage("Bem-vindo à Cantina!").split("\n")[0]).toBe("Bem-vindo à Cantina!");
  });

  it("textos salvos valem; o que faltar ou vier vazio usa o padrão", () => {
    const texts = automationTextsOf({ automationTexts: { phoneRequest: "Seu telefone, por favor?", phoneReminder: "  " } });
    expect(texts).toEqual({ ...AUTOMATION_TEXT_DEFAULTS, phoneRequest: "Seu telefone, por favor?" });
    expect(automationTextsOf(null)).toEqual(AUTOMATION_TEXT_DEFAULTS);
  });
});

describe("horário de funcionamento", () => {
  const hours: BusinessHours = {
    enabled: true,
    // domingo fechado; seg a qui 18h–23h; sex e sáb 18h–02h (passa da meia-noite)
    days: [closed, ...Array(4).fill({ open: "18:00", close: "23:00" }), { open: "18:00", close: "02:00" }, { open: "18:00", close: "02:00" }],
    closedMessage: "Fechados",
  };

  it("aberto dentro do turno e fechado fora", () => {
    expect(isOpenAt(hours, at("2026-10-05T18:00:00"))).toBe(true); // segunda, abrindo
    expect(isOpenAt(hours, at("2026-10-05T22:59:00"))).toBe(true);
    expect(isOpenAt(hours, at("2026-10-05T23:00:00"))).toBe(false); // fechou
    expect(isOpenAt(hours, at("2026-10-05T12:00:00"))).toBe(false);
    expect(isOpenAt(hours, at("2026-10-04T20:00:00"))).toBe(false); // domingo fechado
  });

  it("turno que passa da meia-noite vale até o fechamento do dia seguinte", () => {
    expect(isOpenAt(hours, at("2026-10-10T01:30:00"))).toBe(true); // sábado de madrugada: turno de sexta
    expect(isOpenAt(hours, at("2026-10-11T01:30:00"))).toBe(true); // domingo de madrugada: turno de sábado
    expect(isOpenAt(hours, at("2026-10-11T02:00:00"))).toBe(false);
    expect(isOpenAt(hours, at("2026-10-06T01:00:00"))).toBe(false); // segunda não passa da meia-noite
  });
});
