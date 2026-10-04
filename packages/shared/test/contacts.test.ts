import { describe, expect, it } from "vitest";
import { formatPhone, isValidCpf, maskCpf, phoneFromWhatsAppId, toE164, UpdateContactRequest } from "../src/index.js";

describe("telefone", () => {
  it("normaliza o que o cliente ou o atendente digita para E.164", () => {
    expect(toE164("(11) 97654-3210")).toBe("+5511976543210");
    expect(toE164("11976543210")).toBe("+5511976543210");
    expect(toE164("+55 11 97654-3210")).toBe("+5511976543210");
    expect(toE164("meu número é 123")).toBeNull();
  });

  it("põe o 9 nos celulares brasileiros que o WhatsApp identifica sem ele", () => {
    expect(phoneFromWhatsAppId("558699731647")).toBe("+5586999731647");
    expect(phoneFromWhatsAppId("5586999731647")).toBe("+5586999731647");
    expect(phoneFromWhatsAppId("551133334444")).toBe("+551133334444"); // fixo
    expect(phoneFromWhatsAppId("15551738904")).toBe("+15551738904"); // fora do Brasil
  });

  it("formata para exibição", () => {
    expect(formatPhone("+5511976543210")).toBe("(11) 97654-3210");
  });
});

describe("CPF", () => {
  it("valida os dígitos verificadores", () => {
    expect(isValidCpf("12345678909")).toBe(true);
    expect(isValidCpf("12345678900")).toBe(false);
    expect(isValidCpf("11111111111")).toBe(false);
    expect(isValidCpf("123.456.789-09")).toBe(false); // só dígitos
  });

  it("mascara para exibição e recusa CPF inválido na edição", () => {
    expect(maskCpf("12345678909")).toBe("***.456.789-**");
    expect(UpdateContactRequest.safeParse({ cpf: "12345678900" }).success).toBe(false);
    expect(UpdateContactRequest.safeParse({ cpf: "12345678909" }).success).toBe(true);
  });
});
