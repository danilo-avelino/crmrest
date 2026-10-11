import { describe, expect, it } from "vitest";
import { formatTaxId, isValidCnpj, SignupRequest, tenantBlock } from "../src/index.js";

describe("CNPJ", () => {
  it("valida os dígitos verificadores, também no formato alfanumérico", () => {
    expect(isValidCnpj("66832307000167")).toBe(true);
    expect(isValidCnpj("66832307000168")).toBe(false);
    expect(isValidCnpj("12ABC34501DE35")).toBe(true);
    expect(isValidCnpj("12ABC34501DE36")).toBe(false);
    expect(isValidCnpj("00000000000000")).toBe(false);
    expect(isValidCnpj("66.832.307/0001-67")).toBe(false); // sem pontuação
  });

  it("formata CPF e CNPJ para exibição", () => {
    expect(formatTaxId("12345678909")).toBe("123.456.789-09");
    expect(formatTaxId("66832307000167")).toBe("66.832.307/0001-67");
  });
});

describe("cadastro pelo site", () => {
  const valid = {
    restaurantName: " Cantina da Nonna ",
    name: "Bruna Lima",
    phone: "(86) 99817-9385",
    taxId: "66.832.307/0001-67",
    email: "Bruna@Cantina.com",
    password: "senha-forte-123",
  };

  it("normaliza o WhatsApp, o CPF/CNPJ e o e-mail", () => {
    expect(SignupRequest.parse(valid)).toEqual({
      restaurantName: "Cantina da Nonna",
      name: "Bruna Lima",
      phone: "+5586998179385",
      taxId: "66832307000167",
      email: "bruna@cantina.com",
      password: "senha-forte-123",
    });
    expect(SignupRequest.parse({ ...valid, taxId: "123.456.789-09" }).taxId).toBe("12345678909");
    expect(SignupRequest.parse({ ...valid, taxId: "12.abc.345/01de-35" }).taxId).toBe("12ABC34501DE35");
  });

  it("recusa WhatsApp, CPF/CNPJ e senha inválidos", () => {
    const message = (field: object) => SignupRequest.safeParse({ ...valid, ...field }).error?.issues[0]?.message;
    expect(message({ phone: "12345" })).toBe("Informe um WhatsApp válido, com DDD.");
    expect(message({ taxId: "123.456.789-00" })).toBe("Informe um CPF ou CNPJ válido.");
    expect(message({ password: "curta" })).toBe("Use pelo menos 8 caracteres.");
  });
});

describe("bloqueio do restaurante", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const past = new Date("2026-10-10T12:00:00Z");
  const future = new Date("2026-10-12T12:00:00Z");

  it("restaurante criado pela plataforma nunca é bloqueado", () => {
    expect(tenantBlock({ trialEndsAt: null, paidUntil: null }, now)).toBeNull();
  });

  it("bloqueia quando o teste acaba sem pagamento e quando a assinatura vence", () => {
    expect(tenantBlock({ trialEndsAt: future, paidUntil: null }, now)).toBeNull();
    expect(tenantBlock({ trialEndsAt: past, paidUntil: null }, now)).toBe("trial");
    expect(tenantBlock({ trialEndsAt: past, paidUntil: future }, now)).toBeNull();
    expect(tenantBlock({ trialEndsAt: past, paidUntil: past }, now)).toBe("payment");
  });

  it("teste encerrado por canal repetido fica bloqueado até pagar", () => {
    expect(tenantBlock({ trialEndsAt: past, paidUntil: null, trialRevokedAt: past }, now)).toBe("reused");
    expect(tenantBlock({ trialEndsAt: past, paidUntil: future, trialRevokedAt: past }, now)).toBeNull();
  });
});
