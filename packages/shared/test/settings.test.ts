import { describe, expect, it } from "vitest";
import { type AutomationMessages, fillMessage, PERSONALITIES, PERSONALITY_MESSAGES } from "../src/personalities.js";
import {
  automationMessagesOf,
  automationTextDefaults,
  automationTextsOf,
  type BusinessHours,
  businessHoursOf,
  isOpenAt,
  menuMessage,
} from "../src/settings.js";

// Horários de Brasília (-03:00). 2026-10-05 é segunda-feira.
const at = (iso: string) => new Date(`${iso}-03:00`);
const closed = null;
const CORDIAL = automationTextDefaults("cordial");

describe("mensagens automáticas", () => {
  it("saudação com e sem o nome do cliente, sempre com as opções do menu", () => {
    expect(menuMessage(CORDIAL.greeting, "Maria")).toBe(
      "Olá, Maria! 👋 Em que podemos ajudar?\n1 - Falar sobre um pedido\n2 - Fazer um pedido\n3 - Outro assunto",
    );
    expect(menuMessage(CORDIAL.greeting).split("\n")[0]).toBe("Olá! 👋 Em que podemos ajudar?");
    expect(menuMessage("Bem-vindo à Cantina!").split("\n")[0]).toBe("Bem-vindo à Cantina!");
  });

  it("textos salvos valem; o que faltar ou vier vazio usa o padrão", () => {
    const texts = automationTextsOf({ automationTexts: { phoneRequest: "Seu telefone, por favor?", phoneReminder: "  " } });
    expect(texts).toEqual({ ...CORDIAL, phoneRequest: "Seu telefone, por favor?" });
    expect(automationTextsOf(null)).toEqual(CORDIAL);
  });
});

describe("personalidade do atendimento", () => {
  /** Marcadores que cada mensagem precisa ter: sem eles, o cliente não recebe o número do pedido, a hora... */
  const REQUIRED: Partial<Record<keyof AutomationMessages, string[]>> = {
    greeting: ["nome"],
    orderFound: ["pedido", "status"],
    orderNotFound: ["pedido"],
    forecast: ["hora"],
    forecastLate: ["hora"],
    queueMany: ["quantidade"],
    dispatched: ["hora", "tempo"],
    dispatchNotice: ["pedido", "hora"],
    deliveredNotice: ["pedido"],
  };

  it.each(PERSONALITIES)("%s: todas as mensagens preenchidas, com os marcadores certos", (personality) => {
    for (const [key, text] of Object.entries(PERSONALITY_MESSAGES[personality]) as [keyof AutomationMessages, string][]) {
      expect(text.trim(), key).not.toBe("");
      const markers = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      expect(markers, key).toEqual([...(REQUIRED[key] ?? [])].sort());
    }
    // A resposta da pesquisa é lida como nota de 1 a 5.
    expect(PERSONALITY_MESSAGES[personality].surveyQuestion).toMatch(/1 a 5/);
  });

  it("sem escolha, o tom é o cordial; os textos editados pelo admin valem sobre os da personalidade", () => {
    expect(automationMessagesOf({})).toEqual(PERSONALITY_MESSAGES.cordial);
    const settings = { personality: "jovial", automationTexts: { greeting: "Bem-vindo, {nome}!" } };
    expect(automationMessagesOf(settings)).toEqual({ ...PERSONALITY_MESSAGES.jovial, greeting: "Bem-vindo, {nome}!" });
    expect(businessHoursOf({ personality: "formal" }).closedMessage).toBe(PERSONALITY_MESSAGES.formal.closedMessage);
    expect(automationMessagesOf({ personality: "inexistente" })).toEqual(PERSONALITY_MESSAGES.cordial);
  });

  it("troca os marcadores pelos valores", () => {
    expect(fillMessage("Pedido #{pedido} às {hora}. {outro}", { pedido: 95, hora: "19:45" })).toBe("Pedido #95 às 19:45. {outro}");
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
