import type { BillingPlan } from "@dishdesk/database/enums";
import { z } from "zod";
import { isValidCpf, toE164 } from "./contacts.js";

// Cadastro pelo site, teste grátis e assinatura.

export const TRIAL_DAYS = 15;

/** Um canal que passou por um teste grátis só entra em outro teste este tanto de dias depois de o primeiro acabar. */
export const TRIAL_REUSE_DAYS = 60;

/** Planos da assinatura: mensal no cartão (renova sozinho) ou anual em pagamento único, no meio que o cliente escolher. */
export const BILLING_PLANS = {
  monthly: { amountCents: 9_900 },
  annual: { amountCents: 99_900 },
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

// CPF ou CNPJ de quem vai receber a nota fiscal; fica guardado sem pontuação.
const TaxId = z
  .string()
  .transform((taxId) => taxId.replace(/[^0-9a-z]/gi, "").toUpperCase())
  .refine((taxId) => isValidCpf(taxId) || isValidCnpj(taxId), "Informe um CPF ou CNPJ válido.");

/** Cadastro pelo site: cria o restaurante em teste com quem se cadastrou como administrador. */
export const SignupRequest = z.object({
  restaurantName: z.string().trim().min(1, "Informe o nome do restaurante.").max(80, "Use até 80 caracteres."),
  name: z.string().trim().min(1, "Informe o seu nome.").max(80, "Use até 80 caracteres."),
  phone: z
    .string()
    .refine((phone) => toE164(phone) !== null, "Informe um WhatsApp válido, com DDD.")
    .transform((phone) => toE164(phone)!),
  taxId: TaxId,
  email: z.email({ error: "Informe um e-mail válido." }).transform((email) => email.toLowerCase()),
  password: z.string().min(8, "Use pelo menos 8 caracteres.").max(128, "Use até 128 caracteres."),
});
export type SignupRequest = z.infer<typeof SignupRequest>;

/**
 * Com a assinatura vencida, o restaurante pode liberar o próprio acesso por este tanto de dias ("Liberar acesso por
 * confiança"), uma vez por atraso: o direito volta quando o pagamento chega.
 */
export const TRUST_DAYS = 3;

/**
 * Por que o restaurante está bloqueado: o teste acabou sem pagamento, a assinatura venceu, o teste foi encerrado
 * porque um canal conectado já tinha passado por outro teste grátis ("reused") ou o restaurante foi adicionado por
 * quem já tem conta e espera o primeiro pagamento ("unpaid").
 */
export type TenantBlock = "trial" | "payment" | "reused" | "unpaid";

type TenantAccess = {
  trialEndsAt: Date | null;
  paidUntil: Date | null;
  trialRevokedAt?: Date | null;
  trustUntil?: Date | null;
  createdAt?: Date;
};

/**
 * Restaurante criado pela plataforma (sem trialEndsAt) nunca é bloqueado. O adicionado por quem já tem conta não tem
 * teste grátis: nasce com trialEndsAt igual a createdAt.
 */
export function tenantBlock(tenant: TenantAccess, now = new Date()): TenantBlock | null {
  if (!tenant.trialEndsAt) return null;
  if (tenant.paidUntil) return tenant.paidUntil > now || (tenant.trustUntil && tenant.trustUntil > now) ? null : "payment";
  if (tenant.trialEndsAt.getTime() === tenant.createdAt?.getTime()) return "unpaid";
  if (tenant.trialRevokedAt) return "reused";
  return tenant.trialEndsAt > now ? null : "trial";
}

/** Cobrança de um restaurante que se cadastrou pelo site, como o painel mostra. */
export type TenantBilling = {
  /** Último plano pago; null enquanto só houve o teste grátis. */
  plan: BillingPlan | null;
  /** Fim do teste grátis ou do período pago. */
  accessUntil: string;
  /** Pagamento pendente com o acesso liberado por confiança até esta data. */
  trustUntil: string | null;
  /** Pagamento pendente e a liberação por confiança deste atraso ainda não foi usada. */
  trustAvailable: boolean;
};

/** null = restaurante criado pela plataforma, sem cobrança pelo sistema. */
export function tenantBilling(tenant: TenantAccess & { billingPlan: BillingPlan | null }, now = new Date()): TenantBilling | null {
  if (!tenant.trialEndsAt) return null;
  const overdue = Boolean(tenant.paidUntil && tenant.paidUntil <= now);
  return {
    plan: tenant.billingPlan,
    accessUntil: (tenant.paidUntil ?? tenant.trialEndsAt).toISOString(),
    trustUntil: overdue && tenant.trustUntil && tenant.trustUntil > now ? tenant.trustUntil.toISOString() : null,
    trustAvailable: overdue && !tenant.trustUntil,
  };
}

export const CheckoutRequest = z.object({ tenantId: z.uuid(), plan: z.enum(["monthly", "annual"]) });
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;

/** Endereço da página da Stripe: o pagamento ou, para quem já assina o mensal, a troca do cartão. */
export type CheckoutResponse = { url: string };

export const TrustReleaseRequest = z.object({ tenantId: z.uuid() });
export type TrustReleaseRequest = z.infer<typeof TrustReleaseRequest>;

/**
 * Administrador que adiciona outro restaurante na escolha de restaurante. O novo não tem teste grátis: espera o
 * primeiro pagamento. Só o super admin cria um restaurante de teste, sem cobrança (e sem CPF/CNPJ).
 */
export const AddTenantRequest = z
  .object({
    name: z.string().trim().min(1, "Informe o nome do restaurante.").max(80, "Use até 80 caracteres."),
    taxId: TaxId.optional(),
    test: z.boolean().default(false),
  })
  .refine((body) => body.test || body.taxId, { path: ["taxId"], message: "Informe um CPF ou CNPJ válido." });
export type AddTenantRequest = z.infer<typeof AddTenantRequest>;

export type AddTenantResponse = { tenantId: string };
