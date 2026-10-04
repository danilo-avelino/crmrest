import { describe, expect, it } from "vitest";
import { ago, currency, dayLabel, initials, remaining, tenure } from "./format";

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
  });
});
