import type { BillingPlan, ModuleKey } from "@dishdesk/database/enums";
import { z } from "zod";

// Painel da plataforma (Super Admin, E16): restaurantes, uso, plano, módulos e auditoria.

/** Módulos pagos à parte do plano, que a plataforma liga por restaurante. */
export const MODULES = ["CAMPAIGNS"] as const satisfies readonly ModuleKey[];
export const MODULE_LABEL: Record<ModuleKey, string> = { CAMPAIGNS: "Campanhas" };

/** Restaurante como aparece na lista da plataforma, com o uso de cada um. */
export type PlatformTenantDto = {
  id: string;
  name: string;
  slug: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: string;
  /** Só em quem se cadastrou pelo site: fim do teste, pago até, WhatsApp e CPF/CNPJ (sem pontuação) de contato. */
  trialEndsAt: string | null;
  paidUntil: string | null;
  /** Último plano pago (ou liberado pela plataforma). */
  billingPlan: BillingPlan | null;
  /** Módulos ligados. */
  modules: ModuleKey[];
  contactPhone: string | null;
  taxId: string | null;
  activeMembers: number;
  connectedChannels: number;
  openConversations: number;
  /** Mensagens (recebidas e enviadas) nos últimos 30 dias. */
  messagesLast30Days: number;
};

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Novo restaurante já com o primeiro administrador (quem já tem conta mantém a senha atual). */
export const CreateTenantRequest = z.object({
  name: z.string().trim().min(1, "Informe o nome do restaurante.").max(80, "Use até 80 caracteres."),
  slug: z
    .string()
    .trim()
    .min(2, "Use pelo menos 2 caracteres.")
    .max(60, "Use até 60 caracteres.")
    .regex(SLUG_PATTERN, "Use só letras minúsculas, números e hífen."),
  adminName: z.string().trim().min(1, "Informe o nome do administrador.").max(80, "Use até 80 caracteres."),
  adminEmail: z.email({ error: "Informe um e-mail válido." }).transform((email) => email.toLowerCase()),
  adminPassword: z.string().min(8, "Use pelo menos 8 caracteres.").max(128, "Use até 128 caracteres."),
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequest>;

export const UpdateTenantStatusRequest = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) });
export type UpdateTenantStatusRequest = z.infer<typeof UpdateTenantStatusRequest>;

/**
 * Acesso liberado à mão (pagamento por fora da Stripe ou cortesia), só para quem se cadastrou pelo site: o plano e o
 * último dia liberado (AAAA-MM-DD, até o fim do dia em Brasília).
 */
export const UpdateTenantAccessRequest = z.object({
  plan: z.enum(["MONTHLY", "ANNUAL"]),
  paidUntil: z.iso.date({ error: "Informe a data." }),
});
export type UpdateTenantAccessRequest = z.infer<typeof UpdateTenantAccessRequest>;

export const UpdateTenantModuleRequest = z.object({ enabled: z.boolean() });
export type UpdateTenantModuleRequest = z.infer<typeof UpdateTenantModuleRequest>;

/** Ação da plataforma registrada na auditoria (criação, suspensão, acesso de suporte, acesso liberado, módulos). */
export type PlatformAuditDto = {
  id: string;
  action:
    | "tenant.create"
    | "tenant.suspend"
    | "tenant.reactivate"
    | "tenant.support_access"
    | "tenant.access_grant"
    | "tenant.module_on"
    | "tenant.module_off";
  userName: string | null;
  tenantId: string | null;
  tenantName: string | null;
  /** Detalhes: o módulo ligado ou desligado; o plano e a data do acesso liberado. */
  data: { module?: ModuleKey; plan?: BillingPlan; paidUntil?: string } | null;
  createdAt: string;
};

/** "Grupo Moby Dick" → "grupo-moby-dick". */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
}
