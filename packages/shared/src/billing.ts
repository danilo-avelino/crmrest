import { z } from "zod";
import { isValidCpf, toE164 } from "./contacts.js";

// Cadastro pelo site, teste grátis e assinatura.

export const TRIAL_DAYS = 15;

/** Um canal que passou por um teste grátis só entra em outro teste este tanto de dias depois de o primeiro acabar. */
export const TRIAL_REUSE_DAYS = 60;

/** Planos da assinatura: mensal no cartão (renova sozinho) ou anual no Pix (pagamento único). */
export const BILLING_PLANS = {
  monthly: { amountCents: 9_900, method: "card" },
  annual: { amountCents: 99_900, method: "pix" },
} as const;
export type BillingPlanKey = keyof typeof BILLING_PLANS;

/** CNPJ com os dígitos verificadores corretos, sem pontuação. Aceita o alfanumérico (letras nas 12 primeiras posições). */
export function isValidCnpj(value: string): boolean {
  if (!/^[0-9A-Z]{12}\d{2}$/.test(value) || /^(\d)\1{13}$/.test(value)) return false;
  const check = (length: number) => {
    let sum = 0;
    // Pesos de 2 a 9 da direita para a esquerda; cada caractere vale o código ASCII menos 48 ("A" = 17).
    for (let i = 0; i < length; i++) sum += (value.charCodeAt(i) - 48) * (((length - 1 - i) % 8) + 2);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return check(12) === Number(value[12]) && check(13) === Number(value[13]);
}

/** CPF ou CNPJ sem pontuação → "123.456.789-09" ou "12.345.678/0001-95". */
export function formatTaxId(value: string): string {
  return value.length === 11
    ? value.replace(/^(.{3})(.{3})(.{3})(.{2})$/, "$1.$2.$3-$4")
    : value.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, "$1.$2.$3/$4-$5");
}

/** Cadastro pelo site: cria o restaurante em teste com quem se cadastrou como administrador. */
export const SignupRequest = z.object({
  restaurantName: z.string().trim().min(1, "Informe o nome do restaurante.").max(80, "Use até 80 caracteres."),
  name: z.string().trim().min(1, "Informe o seu nome.").max(80, "Use até 80 caracteres."),
  phone: z
    .string()
    .refine((phone) => toE164(phone) !== null, "Informe um WhatsApp válido, com DDD.")
    .transform((phone) => toE164(phone)!),
  // CPF ou CNPJ de quem vai receber a nota fiscal; fica guardado sem pontuação.
  taxId: z
    .string()
    .transform((taxId) => taxId.replace(/[^0-9a-z]/gi, "").toUpperCase())
    .refine((taxId) => isValidCpf(taxId) || isValidCnpj(taxId), "Informe um CPF ou CNPJ válido."),
  email: z.email({ error: "Informe um e-mail válido." }).transform((email) => email.toLowerCase()),
  password: z.string().min(8, "Use pelo menos 8 caracteres.").max(128, "Use até 128 caracteres."),
});
export type SignupRequest = z.infer<typeof SignupRequest>;

/**
 * Por que o restaurante está bloqueado: o teste acabou sem pagamento, a assinatura venceu ou o teste foi encerrado
 * porque um canal conectado já tinha passado por outro teste grátis ("reused").
 */
export type TenantBlock = "trial" | "payment" | "reused";

/** Restaurante criado pela plataforma (sem trialEndsAt) nunca é bloqueado. */
export function tenantBlock(
  tenant: { trialEndsAt: Date | null; paidUntil: Date | null; trialRevokedAt?: Date | null },
  now = new Date(),
): TenantBlock | null {
  if (!tenant.trialEndsAt) return null;
  if (tenant.paidUntil) return tenant.paidUntil > now ? null : "payment";
  if (tenant.trialRevokedAt) return "reused";
  return tenant.trialEndsAt > now ? null : "trial";
}

export const CheckoutRequest = z.object({ tenantId: z.uuid(), plan: z.enum(["monthly", "annual"]) });
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;

/** Endereço da página de pagamento da Stripe. */
export type CheckoutResponse = { url: string };
