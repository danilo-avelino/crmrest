import { describe, expect, it } from "vitest";
import { idleLabel, maskedPhone } from "@/components/menu/abandoned-carts";

describe("tempo parado do carrinho", () => {
  it("minutos, horas e dias", () => {
    const now = Date.parse("2026-11-22T20:00:00Z");
    expect(idleLabel("2026-11-22T19:15:00Z", now)).toBe("há 45 min");
    expect(idleLabel("2026-11-22T17:00:00Z", now)).toBe("há 3 h");
    expect(idleLabel("2026-11-21T20:00:00Z", now)).toBe("há 1 dia");
    expect(idleLabel("2026-11-19T20:00:00Z", now)).toBe("há 3 dias");
  });
});

describe("telefone mascarado na lista", () => {
  it("mostra DDD, o primeiro dígito e os 4 últimos", () => {
    expect(maskedPhone("+5511987652210")).toBe("(11) 9••••-2210");
    expect(maskedPhone(null)).toBeNull();
  });
});
