import { describe, expect, it } from "vitest";
import type { CartLine } from "./public-cart";
import type { CheckoutState } from "./public-checkout";
import {
  changeHint,
  confirmationHead,
  EMPTY_PAYMENT,
  orderRequestOf,
  outcomeOf,
  parseMoney,
  payLaterTitle,
  paymentLine,
  pendingOrderKey,
  orderPlaced,
  orderToken,
  reviewModel,
  validatePayment,
} from "./public-order";

const line = (extra: Partial<CartLine> = {}): CartLine => ({
  id: "l1",
  itemId: "item-1",
  name: "Calabresa",
  sizeId: "size-1",
  sizeName: "Grande",
  half: null,
  options: { bacon: 2 },
  optionLines: [{ id: "bacon", name: "Bacon", priceCents: 300 }],
  quantity: 1,
  note: "sem cebola",
  unitCents: 5600,
  totalCents: 5600,
  pricedAt: 0,
  ...extra,
});

const address = { zipCode: "01001000", street: "Rua A", number: "10", noNumber: false, complement: "ap 2", district: "Centro", city: "São Paulo", state: "SP", reference: "" };
const delivery: CheckoutState = {
  identity: { kind: "guest", name: "Ana", phone: "+5511987654321" },
  mode: "DELIVERY",
  when: { kind: "now" },
  address: { kind: "new", address, lat: null, lng: null, saveAs: "Casa" },
  quote: { feeCents: 500, eta: { minMinutes: 30, maxMinutes: 50 }, freeDelivery: false },
};
const pickup: CheckoutState = { ...delivery, mode: "PICKUP", address: null, quote: { feeCents: 0, eta: { minMinutes: 20, maxMinutes: 20 }, freeDelivery: false } };
const store = { address: "Rua da Loja, 1 · Centro", name: "Forno da Vila" };
const now = new Date("2026-11-21T22:00:00Z"); // 19:00 em Brasília

describe("pagamento (W11)", () => {
  it("R15: o rótulo segue o modo, 'na retirada' quando é para retirar", () => {
    expect(payLaterTitle("DELIVERY")).toBe("Pagar na entrega");
    expect(payLaterTitle("PICKUP")).toBe("Pagar na retirada");
    expect(reviewModel(pickup, [line()], { method: "debit", changeForCents: null }, store, now).payName).toBe("Cartão de débito na retirada");
    expect(paymentLine({ mode: "PICKUP", payment: { method: "cash", changeForCents: null } })).toBe("Dinheiro na retirada");
  });

  it("sem forma escolhida, o erro fica no bloco; cartão passa sem troco", () => {
    expect(validatePayment(EMPTY_PAYMENT, 6100)).toEqual({ ok: false, errors: { method: "Escolha uma forma de pagamento" } });
    expect(validatePayment({ ...EMPTY_PAYMENT, method: "credit", changeFor: "1" }, 6100)).toEqual({ ok: true, method: "credit", changeForCents: null });
  });

  it("dinheiro: pergunta o troco e exige valor maior que o total", () => {
    const cash = { ...EMPTY_PAYMENT, method: "cash" as const };
    expect(validatePayment(cash, 6100)).toMatchObject({ ok: false, errors: { change: "Diga se precisa de troco." } });
    expect(validatePayment({ ...cash, needsChange: false }, 6100)).toEqual({ ok: true, method: "cash", changeForCents: null });
    expect(validatePayment({ ...cash, needsChange: true, changeFor: "abc" }, 6100)).toMatchObject({ ok: false, errors: { change: "Informe o valor para o troco." } });
    const low = validatePayment({ ...cash, needsChange: true, changeFor: "61,00" }, 6100);
    expect(low.ok).toBe(false);
    expect(!low.ok && low.errors.change).toMatch(/^Precisa ser maior que o total de R\$\s61,00\.$/);
    expect(validatePayment({ ...cash, needsChange: true, changeFor: "100" }, 6100)).toEqual({ ok: true, method: "cash", changeForCents: 10_000 });
    expect(changeHint(10_000, 6100, "DELIVERY")).toMatch(/^O entregador leva R\$\s39,00 de troco\.$/);
  });

  it("lê o valor como o cliente digita", () => {
    expect(parseMoney("100,00")).toBe(10_000);
    expect(parseMoney("R$ 1.234,5")).toBe(123_450);
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("12,345")).toBeNull();
  });
});

describe("revisão (W12)", () => {
  it("mostra previsão, endereço com a taxa, pagamento e o total no botão", () => {
    const model = reviewModel(delivery, [line()], { method: "cash", changeForCents: 10_000 }, store, now);
    expect(model).toMatchObject({
      whenLabel: "Chega em 30–50 min",
      whenValue: "entre 19:30 e 19:50",
      modeTitle: "Entrega",
      addressLabel: "Casa",
      addressLines: ["Rua A, 10, ap 2", "Centro, São Paulo · taxa R$ 5,00"],
      payName: "Dinheiro na entrega",
      subtotalCents: 5600,
      deliveryFeeCents: 500,
      totalCents: 6100,
    });
    expect(model.payDetail).toMatch(/^Troco para R\$\s100,00 · seu troco: R\$\s39,00$/);
    expect(model.cta).toMatch(/^Fazer pedido · R\$\s61,00$/);
  });

  it("agendado mostra a faixa escolhida; retirada não cobra entrega", () => {
    const slot = { start: "2026-11-21T22:30:00.000Z", end: "2026-11-21T23:00:00.000Z", day: "today" as const, label: "19:30–20:00" };
    const model = reviewModel({ ...pickup, when: { kind: "scheduled", slot } }, [line()], { method: "credit", changeForCents: null }, store, now);
    expect(model).toMatchObject({ whenLabel: "Agendado para hoje", whenValue: "19:30 – 20:00", modeTitle: "Retirada", deliveryFeeCents: 0, totalCents: 5600 });
  });

  it("monta o envio: escolhas de cada linha com o total visto, endereço novo e a mesma chave", () => {
    const body = orderRequestOf({ state: delivery, lines: [line()], payment: { method: "cash", changeForCents: 10_000 }, notes: "  interfone  ", idempotencyKey: "k1" });
    expect(body).toEqual({
      idempotencyKey: "k1",
      lines: [{ lineId: "l1", itemId: "item-1", sizeId: "size-1", halves: [], optionIds: ["bacon", "bacon"], quantity: 1, note: "sem cebola", expectedTotalCents: 5600 }],
      fulfillment: {
        mode: "DELIVERY",
        address: { street: "Rua A", number: "10", complement: "ap 2", district: "Centro", city: "São Paulo", state: "SP", zipCode: "01001000", reference: null },
        lat: null,
        lng: null,
        saveAs: "Casa",
      },
      when: { kind: "now" },
      payment: { method: "cash", changeForCents: 10_000 },
      customer: { name: "Ana", phone: "+5511987654321" },
      notes: "interfone",
    });
    const saved = orderRequestOf({
      state: { ...delivery, identity: { kind: "otp", name: "Bia", phone: "+5511" }, address: { kind: "saved", id: "addr-1", title: "Casa", area: "Centro", district: "Centro" } },
      lines: [line()],
      payment: { method: "debit", changeForCents: null },
      notes: "",
      idempotencyKey: "k2",
    });
    expect(saved.fulfillment).toEqual({ mode: "DELIVERY", savedAddressId: "addr-1" });
    expect(orderRequestOf({ state: pickup, lines: [line()], payment: { method: "debit", changeForCents: null }, notes: "", idempotencyKey: "k3" }).fulfillment).toEqual({ mode: "PICKUP" });
  });
});

describe("envio (W13) e confirmação (W15)", () => {
  it("cada código da API vira uma tela; sem resposta é falha de rede", () => {
    expect(outcomeOf(200, { id: "o1", code: "1001", token: "t" })).toEqual({ kind: "ok", id: "o1", code: "1001", token: "t" });
    expect(outcomeOf(0, null)).toEqual({ kind: "network" });
    expect(outcomeOf(502, {})).toEqual({ kind: "network" });
    const slot = { start: "s", end: "e", day: "tomorrow", label: "18:00–18:30" };
    expect(outcomeOf(422, { code: "STORE_CLOSED", message: "Fechou.", nextSlot: slot, paused: false })).toEqual({ kind: "closed", message: "Fechou.", nextSlot: slot, paused: false });
    expect(outcomeOf(422, { code: "ITEM_UNAVAILABLE", message: "x", lines: [{ lineId: "l2" }] })).toMatchObject({ kind: "soldOut", lineIds: ["l2"] });
    expect(outcomeOf(422, { code: "PRICE_CHANGED", message: "x", lines: [{ lineId: "l1", name: "C", fromCents: 1, toCents: 2 }] })).toMatchObject({ kind: "priceChanged", changes: [{ toCents: 2 }] });
    expect(outcomeOf(422, { code: "OUT_OF_AREA", message: "Fora." })).toMatchObject({ kind: "fix", fix: "address" });
    expect(outcomeOf(422, { code: "CHANGE_TOO_LOW", message: "x" })).toMatchObject({ kind: "fix", fix: "payment" });
    expect(outcomeOf(422, { code: "MIN_ORDER", message: "x" })).toMatchObject({ kind: "fix", fix: "bag" });
  });

  it("a chave do envio fica a mesma até o pedido entrar; depois, o token do link fica guardado", () => {
    const memory = new Map<string, string>();
    const store = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
    const key = pendingOrderKey("forno", store);
    expect(pendingOrderKey("forno", store)).toBe(key);
    orderPlaced("forno", "o1", "tok", store);
    expect(orderToken("o1", store)).toBe("tok");
    expect(pendingOrderKey("forno", store)).not.toBe(key);
  });

  it("número principal: previsão da entrega, da retirada ou o horário agendado", () => {
    const placedAt = "2026-11-21T22:00:00.000Z";
    expect(confirmationHead({ mode: "DELIVERY", eta: { minMinutes: 30, maxMinutes: 50 }, placedAt, scheduledFor: null }, now)).toEqual({ label: "Chega entre", value: "19:30 e 19:50" });
    expect(confirmationHead({ mode: "PICKUP", eta: { minMinutes: 20, maxMinutes: 20 }, placedAt, scheduledFor: null }, now)).toEqual({ label: "Fica pronto por volta das", value: "19:20" });
    expect(confirmationHead({ mode: "PICKUP", eta: null, placedAt, scheduledFor: "2026-11-22T21:00:00.000Z" }, now)).toEqual({ label: "Agendado para amanhã", value: "18:00" });
  });
});
