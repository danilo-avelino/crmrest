import { describe, expect, it, vi } from "vitest";
import {
  type CheckoutState,
  checkoutKey,
  chooseIdentity,
  chooseMode,
  EMPTY_CHECKOUT,
  firstMissing,
  isMobilePhone,
  loadCheckout,
  lookupCep,
  maskCep,
  maskPhone,
  nextScreen,
  phoneDigits,
  previousScreen,
  savedAddressTitle,
  saveCheckout,
  stepOf,
  storeContactLink,
  toApiPhone,
  whenLabel,
} from "./public-checkout";

const slot = { start: "2026-11-21T22:30:00.000Z", end: "2026-11-21T22:45:00.000Z", day: "today" as const, label: "19:30–19:45" };
const otp = { kind: "otp" as const, name: "Ana", phone: "+5511987654321" };
const guest = { kind: "guest" as const, name: "Bia", phone: "+5511912345678" };
const newAddress = {
  kind: "new" as const,
  address: { zipCode: "", street: "Rua A", number: "1", noNumber: false, complement: "", district: "Centro", city: "SP", state: "", reference: "" },
  lat: null,
  lng: null,
  saveAs: null,
};
const quote = { feeCents: 500, eta: { minMinutes: 40, maxMinutes: 50 }, freeDelivery: false };

describe("telefone", () => {
  it("aplica a máscara enquanto digita", () => {
    expect(maskPhone("")).toBe("");
    expect(maskPhone("1")).toBe("(1");
    expect(maskPhone("119")).toBe("(11) 9");
    expect(maskPhone("1198765")).toBe("(11) 9876-5");
    expect(maskPhone("1134567890")).toBe("(11) 3456-7890");
    expect(maskPhone("11987654321")).toBe("(11) 98765-4321");
    expect(maskPhone("119876543210000")).toBe("(11) 98765-4321");
  });

  it("normaliza o que foi colado com +55, espaço e traço", () => {
    expect(phoneDigits("+55 (11) 98765-4321")).toBe("11987654321");
    expect(toApiPhone("(11) 98765-4321")).toBe("+5511987654321");
    expect(maskPhone("+5511987654321")).toBe("(11) 98765-4321");
  });

  it("só aceita celular com DDD", () => {
    expect(isMobilePhone("(11) 98765-4321")).toBe(true);
    expect(isMobilePhone("(11) 3456-7890")).toBe(false);
    expect(isMobilePhone("(01) 98765-4321")).toBe(false);
    expect(isMobilePhone("98765-4321")).toBe(false);
  });
});

describe("passos do checkout", () => {
  it("abre na primeira tela que falta", () => {
    expect(firstMissing(EMPTY_CHECKOUT)).toBe("identify");
    expect(firstMissing({ ...EMPTY_CHECKOUT, identity: { ...otp, name: " " } })).toBe("identify");
    expect(firstMissing({ ...EMPTY_CHECKOUT, identity: otp, mode: "DELIVERY" })).toBe("fulfillment");
    expect(firstMissing({ ...EMPTY_CHECKOUT, identity: otp, mode: "DELIVERY", when: { kind: "now" } })).toBe("address");
    expect(firstMissing({ ...EMPTY_CHECKOUT, identity: otp, mode: "DELIVERY", when: { kind: "now" }, address: newAddress, quote })).toBe("payment");
    expect(firstMissing({ ...EMPTY_CHECKOUT, identity: guest, mode: "PICKUP", when: { kind: "scheduled", slot } })).toBe("payment");
  });

  it("retirada pula o endereço na ida e na volta", () => {
    const pickup: CheckoutState = { ...EMPTY_CHECKOUT, identity: guest, mode: "PICKUP", when: { kind: "now" } };
    const delivery: CheckoutState = { ...pickup, mode: "DELIVERY" };
    expect(nextScreen("identify", pickup)).toBe("fulfillment");
    expect(nextScreen("fulfillment", pickup)).toBe("payment");
    expect(nextScreen("fulfillment", delivery)).toBe("address");
    expect(nextScreen("address", delivery)).toBe("payment");
    expect(previousScreen("payment", pickup)).toBe("fulfillment");
    expect(previousScreen("payment", delivery)).toBe("address");
    expect(previousScreen("address", delivery)).toBe("fulfillment");
    expect(previousScreen("fulfillment", delivery)).toBe("identify");
    expect(previousScreen("identify", delivery)).toBeNull();
  });

  it("indicador: identificação, entrega e endereço são o passo 1; pagamento é o 2", () => {
    expect(stepOf("identify")).toBe(1);
    expect(stepOf("address")).toBe(1);
    expect(stepOf("payment")).toBe(2);
  });

  it("trocar o modo apaga a cotação; retirada também esquece o endereço", () => {
    const state: CheckoutState = { ...EMPTY_CHECKOUT, identity: otp, mode: "DELIVERY", when: { kind: "now" }, address: newAddress, quote };
    expect(chooseMode(state, "DELIVERY")).toBe(state);
    expect(chooseMode(state, "PICKUP")).toMatchObject({ mode: "PICKUP", address: null, quote: null });
    expect(chooseMode({ ...state, mode: "PICKUP" }, "DELIVERY")).toMatchObject({ address: newAddress, quote: null });
  });

  it("sair ou trocar de cliente não leva o endereço do anterior (R1)", () => {
    const saved = { kind: "saved" as const, id: "a1", title: "Rua A, 1", area: "Centro", district: "Centro" };
    const state: CheckoutState = { ...EMPTY_CHECKOUT, identity: otp, mode: "DELIVERY", when: { kind: "now" }, address: saved, quote };
    expect(chooseIdentity(state, null)).toEqual({ ...EMPTY_CHECKOUT, mode: "DELIVERY", when: { kind: "now" } });
    expect(chooseIdentity(state, guest).address).toBeNull();
    expect(chooseIdentity(state, { ...otp, name: "Ana Paula" })).toMatchObject({ address: saved, identity: { name: "Ana Paula" } });
  });

  it("rótulo do horário agendado", () => {
    expect(whenLabel(slot)).toBe("hoje 19:30");
    expect(whenLabel({ ...slot, day: "tomorrow" })).toBe("amanhã 19:30");
  });
});

describe("armazenamento", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
  };

  it("guarda e lê o estado por loja", () => {
    const storage = memory();
    const state: CheckoutState = { ...EMPTY_CHECKOUT, identity: guest, mode: "PICKUP", when: { kind: "now" } };
    saveCheckout("forno", state, storage);
    expect(loadCheckout("forno", storage)).toEqual(state);
    expect(loadCheckout("outra", storage)).toEqual(EMPTY_CHECKOUT);
  });

  it("endereço salvo nunca volta para quem não tem o código (R1)", () => {
    const storage = memory();
    const saved = { kind: "saved" as const, id: "a1", title: "Rua A, 1", area: "Centro", district: "Centro" };
    saveCheckout("forno", { ...EMPTY_CHECKOUT, identity: guest, address: saved, quote }, storage);
    expect(loadCheckout("forno", storage)).toMatchObject({ address: null, quote: null });
  });

  it("formato antigo, JSON quebrado ou armazenamento bloqueado: começa vazio", () => {
    const storage = memory();
    storage.setItem(checkoutKey("forno"), JSON.stringify({ v: 0, state: { identity: guest } }));
    expect(loadCheckout("forno", storage)).toEqual(EMPTY_CHECKOUT);
    storage.setItem(checkoutKey("forno"), "{");
    expect(loadCheckout("forno", storage)).toEqual(EMPTY_CHECKOUT);
    const blocked = {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    };
    expect(loadCheckout("forno", blocked)).toEqual(EMPTY_CHECKOUT);
    expect(() => saveCheckout("forno", EMPTY_CHECKOUT, blocked)).not.toThrow();
  });
});

describe("CEP e endereço", () => {
  it("máscara do CEP", () => {
    expect(maskCep("05435000")).toBe("05435-000");
    expect(maskCep("0543")).toBe("0543");
  });

  it("busca o CEP no ViaCEP e trata o CEP inexistente e a falha", async () => {
    const ok = vi.fn(async () => Response.json({ logradouro: "Rua Harmonia", bairro: "Vila Madalena", localidade: "São Paulo", uf: "SP" }));
    expect(await lookupCep("05435-000", ok)).toEqual({ ok: true, street: "Rua Harmonia", district: "Vila Madalena", city: "São Paulo", state: "SP" });
    expect(ok).toHaveBeenCalledWith("https://viacep.com.br/ws/05435000/json/");
    expect(await lookupCep("123", ok)).toEqual({ ok: false, message: "O CEP tem 8 números." });
    expect((await lookupCep("99999999", vi.fn(async () => Response.json({ erro: true })))).ok).toBe(false);
    const down = vi.fn(async () => {
      throw new Error("rede");
    });
    expect(await lookupCep("05435000", down)).toEqual({ ok: false, message: "A busca do CEP não respondeu. Preencha o endereço." });
  });

  it("título do endereço salvo: rótulo quando houver, senão só a rua", () => {
    const base = { id: "a", label: "Casa", street: "Rua Harmonia", number: "412", district: "Vila Madalena", city: "São Paulo", state: "SP", zipCode: null, complement: "apto 32" };
    expect(savedAddressTitle(base)).toEqual({ label: "Casa", street: "Rua Harmonia, 412, apto 32", area: "Vila Madalena · São Paulo" });
    expect(savedAddressTitle({ ...base, label: null, complement: null, number: null })).toEqual({ label: null, street: "Rua Harmonia", area: "Vila Madalena · São Paulo" });
  });

  it("Falar com a loja abre o WhatsApp do telefone da loja", () => {
    expect(storeContactLink("(11) 3456-7890")).toBe("https://wa.me/551134567890");
    expect(storeContactLink("+55 11 98765-4321")).toBe("https://wa.me/5511987654321");
    expect(storeContactLink(null)).toBeNull();
  });
});
