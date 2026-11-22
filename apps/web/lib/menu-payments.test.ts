import { DEFAULT_MENU_STORE } from "@dishdesk/shared";
import { describe, expect, it } from "vitest";
import { NO_PAYMENT_METHOD, paymentsChanged, paymentsToForm, paymentsToPayload, pixToForm } from "./menu-payments";

const ALL = { cash: true, credit: true, debit: true, pix_on_delivery: true };

describe("Pagamentos do cardápio: conversão do formulário", () => {
  it("o padrão tem dinheiro, crédito, débito e Pix na maquininha ligados", () => {
    expect(paymentsToForm(DEFAULT_MENU_STORE)).toEqual(ALL);
  });

  it("loja que só guardou Pix aparece com as formas na entrega (é o que o cliente vê)", () => {
    expect(paymentsToForm({ ...DEFAULT_MENU_STORE, paymentMethods: ["pix"] })).toEqual(ALL);
  });

  it("detecta mudança e grava só as formas ligadas", () => {
    const form = { cash: true, credit: false, debit: true, pix_on_delivery: false };
    expect(paymentsChanged(form, DEFAULT_MENU_STORE)).toBe(true);
    expect(paymentsChanged(paymentsToForm(DEFAULT_MENU_STORE), DEFAULT_MENU_STORE)).toBe(false);
    expect(paymentsToPayload(form, DEFAULT_MENU_STORE)).toMatchObject({ ok: true, body: { paymentMethods: ["cash", "debit"] } });
  });

  it("Pix na maquininha liga sozinho e não vira o Pix online", () => {
    const only = { cash: false, credit: false, debit: false, pix_on_delivery: true };
    expect(paymentsToPayload(only, DEFAULT_MENU_STORE)).toMatchObject({ ok: true, body: { paymentMethods: ["pix_on_delivery"] } });
  });

  it("mantém o Pix online já guardado; sem Pix guardado, não cria", () => {
    const cash = { cash: true, credit: false, debit: false, pix_on_delivery: false };
    expect(paymentsToPayload(cash, { ...DEFAULT_MENU_STORE, paymentMethods: ["pix", "credit"] })).toMatchObject({ body: { paymentMethods: ["pix", "cash"] } });
    expect(paymentsToPayload(cash, { ...DEFAULT_MENU_STORE, paymentMethods: ["pix"] })).toMatchObject({ body: { paymentMethods: ["pix", "cash"] } });
    expect(paymentsToPayload(cash, DEFAULT_MENU_STORE)).toMatchObject({ body: { paymentMethods: ["cash"] } });
  });

  it("recusa nenhuma forma ligada", () => {
    expect(paymentsToPayload({ cash: false, credit: false, debit: false, pix_on_delivery: false }, DEFAULT_MENU_STORE)).toEqual({ ok: false, error: NO_PAYMENT_METHOD });
  });

  it("Pix online: só com o recebedor da plataforma a escolha da tela vale, com o prazo", () => {
    const cash = { cash: true, credit: false, debit: false, pix_on_delivery: false };
    const linked = { ...DEFAULT_MENU_STORE, pixRecipientId: "re_abc123456", paymentMethods: ["cash" as const] };
    expect(pixToForm(linked)).toEqual({ accept: false, expiresMinutes: 15 });
    expect(paymentsChanged(cash, linked, { accept: true, expiresMinutes: 15 })).toBe(true);
    expect(paymentsToPayload(cash, linked, { accept: true, expiresMinutes: 30 })).toMatchObject({ body: { paymentMethods: ["pix", "cash"], pixExpiresMinutes: 30 } });
    expect(paymentsToPayload(cash, { ...linked, paymentMethods: ["pix", "cash"] }, { accept: false, expiresMinutes: 15 })).toMatchObject({ body: { paymentMethods: ["cash"] } });
    // Sem recebedor, a tela não liga o Pix.
    expect(paymentsToPayload(cash, DEFAULT_MENU_STORE, { accept: true, expiresMinutes: 30 })).toMatchObject({ body: { paymentMethods: ["cash"] } });
    expect(paymentsChanged(cash, { ...DEFAULT_MENU_STORE, paymentMethods: ["cash"] }, { accept: true, expiresMinutes: 30 })).toBe(false);
  });
});
