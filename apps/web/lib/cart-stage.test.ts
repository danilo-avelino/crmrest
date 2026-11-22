import { describe, expect, it } from "vitest";
import { CART_STAGE_LABEL, pixCountdown } from "./cart-stage";

describe("carrinho da IA na conversa", () => {
  it("nomeia as quatro etapas", () => {
    expect(Object.values(CART_STAGE_LABEL)).toEqual(["Montando", "Aguardando confirmação", "Aguardando Pix", "Pago"]);
  });

  it("contador do Pix: sem validade fica oculto; depois dela, Expirado", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    expect(pixCountdown(null, now)).toBeNull();
    expect(pixCountdown("2026-11-21T12:09:05Z", now)).toBe("09:05");
    expect(pixCountdown("2026-11-21T11:59:00Z", now)).toBe("Expirado");
  });
});
