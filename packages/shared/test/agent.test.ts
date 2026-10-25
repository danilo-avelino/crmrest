import { describe, expect, it } from "vitest";
import { supportReturn } from "../src/agent.js";

// Horários de Brasília (UTC-3).
const at = (iso: string) => new Date(`${iso}-03:00`);

describe("horário do suporte humano", () => {
  it("aberto em dia útil, das 9h às 18h", () => {
    expect(supportReturn(at("2026-10-26T09:00:00"))).toBeNull(); // segunda
    expect(supportReturn(at("2026-10-30T17:59:00"))).toBeNull(); // sexta
  });

  it("fora do horário, diz quando volta", () => {
    expect(supportReturn(at("2026-10-26T07:30:00"))).toBe("hoje às 9h");
    expect(supportReturn(at("2026-10-27T18:00:00"))).toBe("amanhã às 9h");
    expect(supportReturn(at("2026-10-30T20:00:00"))).toBe("segunda às 9h");
    expect(supportReturn(at("2026-10-25T10:00:00"))).toBe("amanhã às 9h"); // domingo
  });
});
