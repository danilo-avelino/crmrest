import { describe, expect, it } from "vitest";
import { type CheckoutAddressInput, NUMBER_REQUIRED, validateCheckoutAddress } from "../src/index.js";

const full: CheckoutAddressInput = {
  zipCode: "05435-000",
  street: "Rua Harmonia",
  number: "412",
  noNumber: false,
  complement: "Apto 32",
  district: "Vila Madalena",
  city: "São Paulo",
  state: "sp",
  reference: "",
};

describe("endereço do checkout (R3, R12)", () => {
  it("aceita o endereço completo, sem ponto de referência, e normaliza CEP e estado", () => {
    const result = validateCheckoutAddress(full);
    expect(result).toEqual({ ok: true, address: { ...full, zipCode: "05435000", state: "SP" } });
  });

  it("devolve todos os erros de uma vez, em português, um por campo", () => {
    const result = validateCheckoutAddress({ ...full, zipCode: "123", street: " ", number: "", district: "", city: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual({
      zipCode: "O CEP tem 8 números.",
      street: "Informe a rua.",
      number: NUMBER_REQUIRED,
      district: "Informe o bairro.",
      city: "Informe a cidade.",
    });
  });

  it("o erro do número vem junto com os dos outros campos", () => {
    const result = validateCheckoutAddress({ ...full, number: "", district: "" });
    expect(result.ok ? null : Object.keys(result.errors).sort()).toEqual(["district", "number"]);
  });

  it('"Sem número" dispensa o número e descarta o que estava digitado', () => {
    expect(validateCheckoutAddress({ ...full, number: "", noNumber: true })).toMatchObject({ ok: true, address: { number: "", noNumber: true } });
    expect(validateCheckoutAddress({ ...full, number: "12", noNumber: true })).toMatchObject({ ok: true, address: { number: "" } });
  });

  it("ponto de referência, complemento, CEP e estado são opcionais", () => {
    expect(validateCheckoutAddress({ ...full, reference: "", complement: "", zipCode: "", state: "" }).ok).toBe(true);
    expect(validateCheckoutAddress({ ...full, reference: "portão azul" })).toMatchObject({ ok: true, address: { reference: "portão azul" } });
  });

  it("recusa estado fora do formato e textos longos demais", () => {
    const result = validateCheckoutAddress({ ...full, state: "São Paulo", reference: "x".repeat(121) });
    expect(result.ok ? null : result.errors).toEqual({ state: "Use a sigla do estado, como SP.", reference: "O ponto de referência pode ter até 120 caracteres." });
  });
});
