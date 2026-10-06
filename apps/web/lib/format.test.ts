import { describe, expect, it } from "vitest";
import {
  ago,
  currency,
  dayLabel,
  dayTime,
  duration,
  initials,
  lastContact,
  monthYear,
  remaining,
  responseTime,
  score,
  shortDay,
  tenure,
} from "./format";

const now = new Date("2026-10-03T19:30:00-03:00").getTime();
const minutesBefore = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

describe("formatos do design", () => {
  it("tempo relativo curto", () => {
    expect(ago(minutesBefore(0.5), now)).toBe("agora");
    expect(ago(minutesBefore(14), now)).toBe("14 min");
    expect(ago(minutesBefore(130), now)).toBe("2h");
    expect(ago(minutesBefore(3 * 24 * 60), now)).toBe("3d");
  });

  it("dia relativo e tempo restante", () => {
    expect(dayLabel(minutesBefore(23), now)).toMatch(/^Hoje, \d{2}:\d{2}$/);
    expect(dayLabel(minutesBefore(3 * 24 * 60), now)).toBe("3 dias atrás");
    expect(remaining(new Date(now + 18.5 * 3_600_000).toISOString(), now)).toBe("18h");
    expect(remaining(new Date(now + 45 * 60_000).toISOString(), now)).toBe("45 min");
  });

  it("moeda, tempo como cliente e iniciais", () => {
    expect(currency("67.40").replace(/\s/g, " ")).toBe("R$ 67,40");
    expect(tenure(minutesBefore(270 * 24 * 60), now)).toBe("9m");
    expect(initials("Maria Oliveira")).toBe("MO");
    expect(initials("Carlos Eduardo Mendes")).toBe("CM");
    expect(initials(null)).toBe("?");
    expect(initials("Aglio Nero | Pizzeria 🍕")).toBe("AP");
    expect(initials("🍕")).toBe("?");
  });

  it("formatos da tela de clientes", () => {
    const daysBefore = (days: number) => minutesBefore(days * 24 * 60);
    expect(lastContact(minutesBefore(5), now)).toBe("há 5 min");
    expect(lastContact(minutesBefore(130), now)).toBe("há 2 h");
    expect(lastContact(daysBefore(1), now)).toBe("ontem");
    expect(lastContact("2026-09-12T15:00:00-03:00", now)).toBe("12/09");
    expect(duration(daysBefore(3), now)).toBe("3 dias");
    expect(duration(daysBefore(15), now)).toBe("2 semanas");
    expect(duration(daysBefore(31), now)).toBe("1 mês");
    expect(duration(daysBefore(270), now)).toBe("9 meses");
    expect(duration(daysBefore(800), now)).toBe("2 anos");
    expect(monthYear("2026-03-15T12:00:00-03:00")).toBe("mar/2026");
    expect(dayTime(minutesBefore(30), now)).toMatch(/^hoje, \d{2}:\d{2}$/);
    expect(dayTime("2026-10-01T20:14:00-03:00", now)).toMatch(/^01\/10, \d{2}:\d{2}$/);
    expect(shortDay("2026-09-28T12:00:00-03:00", now)).toBe("28/09");
  });

  it("nota média e tempo de resposta (aba Avaliações)", () => {
    expect(score(4.333)).toBe("4,3");
    expect(score(5)).toBe("5,0");
    expect(responseTime(45.4)).toBe("45 s");
    expect(responseTime(12 * 60 + 10)).toBe("12 min");
    expect(responseTime(65 * 60)).toBe("1h 05 min");
  });
});
