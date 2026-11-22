import { describe, expect, it } from "vitest";
import { EMPTY_PAYMENT, formatCpf, outcomeOf, paymentLine, pendingPix, pixCountdown, savePendingPix, validatePayment } from "./public-order";

describe("Pix online no checkout (W14)", () => {
  it("exige CPF válido e o leva no envio", () => {
    expect(validatePayment({ ...EMPTY_PAYMENT, method: "pix", cpf: "111.111.111-11" }, 5000)).toEqual({ ok: false, errors: { cpf: "Informe um CPF válido para o Pix." } });
    expect(validatePayment({ ...EMPTY_PAYMENT, method: "pix", cpf: "529.982.247-25" }, 5000)).toEqual({ ok: true, method: "pix", changeForCents: null, cpf: "52998224725" });
  });

  it("formata o CPF enquanto digita", () => {
    expect(formatCpf("529")).toBe("529");
    expect(formatCpf("5299822")).toBe("529.982.2");
    expect(formatCpf("52998224725999")).toBe("529.982.247-25");
  });

  it("a resposta do Pix vira a tela do QR Code; falha da Pagar.me volta para o pagamento", () => {
    const body = { kind: "pix", paymentId: "p1", token: "t", qrCode: "000201", qrCodeUrl: null, expiresAt: "2026-11-22T20:15:00.000Z", amountCents: 5000 };
    expect(outcomeOf(200, body)).toEqual({ kind: "pix", pix: { paymentId: "p1", token: "t", qrCode: "000201", qrCodeUrl: null, expiresAt: "2026-11-22T20:15:00.000Z", amountCents: 5000 } });
    expect(outcomeOf(502, { code: "PIX_FAILED", message: "Não conseguimos gerar o Pix agora." })).toMatchObject({ kind: "fix", fix: "payment" });
    expect(outcomeOf(422, { code: "CPF_REQUIRED", message: "x" })).toMatchObject({ kind: "fix", fix: "payment" });
    expect(outcomeOf(503, {})).toEqual({ kind: "network" });
  });

  it("contagem do prazo e linha do pagamento", () => {
    const now = new Date("2026-11-22T20:00:00.000Z");
    expect(pixCountdown("2026-11-22T20:14:59.000Z", now)).toBe("14:59");
    expect(pixCountdown("2026-11-22T19:59:00.000Z", now)).toBe("00:00");
    expect(paymentLine({ mode: "DELIVERY", payment: { method: "pix", changeForCents: null } })).toBe("Pago com Pix");
  });

  it("guarda o Pix aberto para voltar ao QR Code depois de recarregar", () => {
    const map = new Map<string, string>();
    const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
    const pix = { paymentId: "p1", token: "t", qrCode: "000201", qrCodeUrl: null, expiresAt: "x", amountCents: 1 };
    savePendingPix("loja", pix, store);
    expect(pendingPix("loja", store)).toEqual(pix);
    savePendingPix("loja", null, store);
    expect(pendingPix("loja", store)).toBeNull();
  });
});
