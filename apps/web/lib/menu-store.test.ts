import { DEFAULT_MENU_STORE } from "@dishdesk/shared";
import { describe, expect, it } from "vitest";
import { formToPayload, publicMenuUrl, storeToForm } from "./menu-store";

const base = { ...DEFAULT_MENU_STORE };

describe("Cardápio e entrega: conversão do formulário", () => {
  it("mostra centavos como R$ e volta a centavos", () => {
    const form = storeToForm({ ...base, minOrderCents: 2550, freeDeliveryFromCents: 8000, delivery: { mode: "BY_DISTRICT", districts: [{ district: "Centro", feeCents: 790 }] } }, "#8E2F1B");
    expect(form.minOrder).toBe("25,50");
    expect(form.districts[0]).toEqual({ district: "Centro", fee: "7,90" });
    const result = formToPayload(form, base);
    expect(result.ok && result.body.minOrderCents).toBe(2550);
    expect(result.ok && result.body.freeDeliveryFromCents).toBe(8000);
    expect(result.ok && result.body.delivery).toEqual({ mode: "BY_DISTRICT", districts: [{ district: "Centro", feeCents: 790 }] });
  });

  it("aceita vírgula, ponto e milhar; frete grátis vazio vira 'nunca'", () => {
    const form = { ...storeToForm(base, "#8E2F1B"), minOrder: "R$ 1.234,50", freeFrom: "" };
    const result = formToPayload(form, base);
    expect(result.ok && result.body.minOrderCents).toBe(123450);
    expect(result.ok && result.body.freeDeliveryFromCents).toBeUndefined();
  });

  it("raios em km com vírgula", () => {
    const form = { ...storeToForm(base, "#8E2F1B"), mode: "BY_RADIUS" as const, radii: [{ maxKm: "2,5", fee: "5" }] };
    const result = formToPayload(form, base);
    expect(result.ok && result.body.delivery).toEqual({ mode: "BY_RADIUS", radii: [{ maxKm: 2.5, feeCents: 500 }] });
  });

  it("recusa valor inválido com a mensagem do campo", () => {
    const form = storeToForm(base, "#8E2F1B");
    expect(formToPayload({ ...form, minOrder: "abc" }, base)).toMatchObject({ ok: false, error: expect.stringContaining("Pedido mínimo") });
    expect(formToPayload({ ...form, deliveryMin: "90", deliveryMax: "30" }, base)).toMatchObject({ ok: false });
    expect(formToPayload({ ...form, accentColor: "red" }, base)).toMatchObject({ ok: false });
    expect(formToPayload({ ...form, districts: [{ district: "", fee: "3" }] }, base)).toMatchObject({ ok: false });
  });

  it("o tema completo vai e volta (desligado quando nunca foi salvo)", () => {
    expect(storeToForm(base, "#8E2F1B").brandTheme).toBe(false);
    const result = formToPayload({ ...storeToForm({ ...base, brandTheme: true }, "#8E2F1B") }, base);
    expect(result.ok && result.body.brandTheme).toBe(true);
  });

  it("monta o link público", () => {
    expect(publicMenuUrl("https://app.dishdesk.com.br", "pizzaria-x")).toBe("https://app.dishdesk.com.br/c/pizzaria-x");
  });
});
