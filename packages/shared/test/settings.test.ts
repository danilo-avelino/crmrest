import { describe, expect, it } from "vitest";
import { type AutomationMessages, fillMessage, PERSONALITIES, PERSONALITY_MESSAGES } from "../src/personalities.js";
import {
  automationMessagesOf,
  BusinessHours,
  businessHoursOf,
  COURIER_MENU_OPTIONS,
  isOpenAt,
  menuMessage,
  reopeningAt,
} from "../src/settings.js";

// Horários de Brasília (-03:00). 2026-10-05 é segunda-feira.
const at = (iso: string) => new Date(`${iso}-03:00`);
const closed: BusinessHours["days"][number] = [];
const CORDIAL = PERSONALITY_MESSAGES.cordial;

describe("mensagens automáticas", () => {
  it("saudação com e sem o nome do cliente, sempre com as opções do menu", () => {
    expect(menuMessage(CORDIAL.greeting, "Maria")).toBe(
      "Olá, Maria! 👋 Em que podemos ajudar?\n1 - Falar sobre um pedido\n2 - Fazer um pedido\n3 - Outro assunto",
    );
    expect(menuMessage(CORDIAL.greeting).split("\n")[0]).toBe("Olá! 👋 Em que podemos ajudar?");
    expect(menuMessage("Bem-vindo à Cantina!").split("\n")[0]).toBe("Bem-vindo à Cantina!");
    expect(menuMessage(PERSONALITY_MESSAGES.cordial.courierGreeting, "João", COURIER_MENU_OPTIONS)).toBe(
      "Olá, João! 👋 Como podemos ajudar na entrega?\n1 - Avisar que cheguei (iFood)\n2 - Avisar que deixei na portaria (iFood)\n3 - Problema com um pedido\n4 - Outro assunto",
    );
  });
});

describe("personalidade do atendimento", () => {
  /** Marcadores que cada mensagem precisa ter: sem eles, o cliente não recebe o número do pedido, a hora... */
  const REQUIRED: Partial<Record<keyof AutomationMessages, string[]>> = {
    greeting: ["nome"],
    closedMessage: ["retorno"],
    orderFound: ["pedido", "status"],
    orderNotFound: ["pedido"],
    forecast: ["hora"],
    forecastLate: ["hora"],
    queueMany: ["quantidade"],
    dispatched: ["hora", "tempo"],
    dispatchNotice: ["pedido", "hora"],
    deliveredNotice: ["pedido"],
    orderCanceled: ["nome", "pedido"],
    readyNotice: ["pedido"],
    courierGreeting: ["nome"],
    courierArrivalConfirmed: ["pedido"],
    courierFrontDeskConfirmed: ["pedido"],
    courierOrderRetry: ["pedido"],
    courierOrderFound: ["pedido"],
    courierOrderNotFound: ["pedido"],
    courierProblemRequest: ["pedido"],
    reviewInvite: ["pedido"],
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

  it("sem escolha, o tom é o cordial; só a mensagem de fora do horário do admin vale sobre a personalidade", () => {
    expect(automationMessagesOf({})).toEqual(PERSONALITY_MESSAGES.cordial);
    // Os textos que o admin trocava antes (automationTexts) continuam guardados, mas não valem mais.
    const hours = { enabled: true, days: Array(7).fill(null), closedMessage: "Fechados. Voltamos {retorno}." };
    const settings = { personality: "jovial", automationTexts: { greeting: "Bem-vindo, {nome}!" }, businessHours: hours };
    expect(automationMessagesOf(settings)).toEqual({ ...PERSONALITY_MESSAGES.jovial, closedMessage: hours.closedMessage });
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
    days: [closed, ...Array(4).fill([{ open: "18:00", close: "23:00" }]), [{ open: "18:00", close: "02:00" }], [{ open: "18:00", close: "02:00" }]],
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

  it("quando o atendimento volta: hoje, amanhã ou o dia da semana", () => {
    expect(reopeningAt(hours, at("2026-10-05T12:00:00"))).toBe("hoje às 18:00"); // segunda, antes de abrir
    expect(reopeningAt(hours, at("2026-10-05T23:30:00"))).toBe("amanhã às 18:00"); // segunda, depois de fechar
    expect(reopeningAt(hours, at("2026-10-10T03:00:00"))).toBe("hoje às 18:00"); // sábado, o turno de sexta acabou às 02:00
    expect(reopeningAt(hours, at("2026-10-11T10:00:00"))).toBe("amanhã às 18:00"); // domingo fechado
    const onlyMonday: BusinessHours = { ...hours, days: [closed, [{ open: "11:00", close: "15:00" }], closed, closed, closed, closed, closed] };
    expect(reopeningAt(onlyMonday, at("2026-10-09T20:00:00"))).toBe("na segunda-feira às 11:00"); // sexta
    expect(reopeningAt(onlyMonday, at("2026-10-05T16:00:00"))).toBe("na segunda-feira às 11:00"); // segunda, já fechou
    expect(reopeningAt({ ...hours, days: Array(7).fill(closed) }, at("2026-10-05T12:00:00"))).toBe("em breve");
  });

  it("mais de um horário no dia: fecha no intervalo e volta no horário seguinte", () => {
    // Todos os dias das 11h às 15h e das 16h às 23h.
    const split = BusinessHours.parse({ ...hours, days: Array(7).fill([{ open: "11:00", close: "15:00" }, { open: "16:00", close: "23:00" }]) });
    expect(isOpenAt(split, at("2026-10-05T14:59:00"))).toBe(true);
    expect(isOpenAt(split, at("2026-10-05T15:30:00"))).toBe(false); // intervalo
    expect(isOpenAt(split, at("2026-10-05T16:00:00"))).toBe(true);
    expect(isOpenAt(split, at("2026-10-05T23:00:00"))).toBe(false);
    expect(reopeningAt(split, at("2026-10-05T15:30:00"))).toBe("hoje às 16:00");
    expect(reopeningAt(split, at("2026-10-05T09:00:00"))).toBe("hoje às 11:00");
    expect(reopeningAt(split, at("2026-10-05T23:30:00"))).toBe("amanhã às 11:00");
    // O último horário do dia pode passar da meia-noite.
    const late = BusinessHours.parse({ ...hours, days: Array(7).fill([{ open: "11:00", close: "15:00" }, { open: "18:00", close: "01:00" }]) });
    expect(isOpenAt(late, at("2026-10-06T00:30:00"))).toBe(true);
    expect(isOpenAt(late, at("2026-10-06T01:00:00"))).toBe(false);
  });

  it("horários de um dia não se sobrepõem, só o último passa da meia-noite, e no máximo 3", () => {
    const withMonday = (monday: unknown) => BusinessHours.safeParse({ ...hours, days: [closed, monday, closed, closed, closed, closed, closed] }).success;
    expect(withMonday([{ open: "11:00", close: "15:00" }, { open: "15:00", close: "23:00" }])).toBe(true);
    expect(withMonday([{ open: "11:00", close: "15:00" }, { open: "14:00", close: "23:00" }])).toBe(false); // sobrepõe
    expect(withMonday([{ open: "16:00", close: "23:00" }, { open: "11:00", close: "15:00" }])).toBe(false); // fora de ordem
    expect(withMonday([{ open: "18:00", close: "01:00" }, { open: "02:00", close: "04:00" }])).toBe(false); // passa da meia-noite antes do último
    const four = ["08:00", "10:00", "12:00", "14:00"].map((open) => ({ open, close: `${Number(open.slice(0, 2)) + 1}:00`.padStart(5, "0") }));
    expect(withMonday(four.slice(0, 3))).toBe(true);
    expect(withMonday(four)).toBe(false);
  });

  it("horário salvo no formato antigo (um turno ou null) continua valendo", () => {
    const old = { enabled: true, days: [null, ...Array(6).fill({ open: "18:00", close: "23:00" })], closedMessage: "Fechados" };
    const read = businessHoursOf({ businessHours: old });
    expect(read.enabled).toBe(true);
    expect(read.days).toEqual([[], ...Array(6).fill([{ open: "18:00", close: "23:00" }])]);
    expect(isOpenAt(read, at("2026-10-05T19:00:00"))).toBe(true);
  });
});
