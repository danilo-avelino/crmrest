import type { BillingPlan, ModuleKey } from "@dishdesk/database/enums";
import { z } from "zod";

// Painel da plataforma (Super Admin, E16): restaurantes, uso, plano, módulos e auditoria.

/** Módulos pagos à parte do plano, que a plataforma liga por restaurante. */
export const MODULES = ["CAMPAIGNS", "AI"] as const satisfies readonly ModuleKey[];
export const MODULE_LABEL: Record<ModuleKey, string> = { CAMPAIGNS: "Campanhas", AI: "Atendimento com IA" };

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

/**
 * Assuntos das sugestões dos restaurantes (a IA escolhe um ao receber a sugestão). A plataforma vê o ranking por
 * assunto, do que tem mais sugestões para o que tem menos.
 */
export const SUGGESTION_SUBJECTS = {
  inbox: "Inbox e atendimento",
  integracoes: "Integrações",
  pedidos: "Pedidos",
  clientes: "Clientes",
  automacoes: "Mensagens automáticas",
  ia: "Atendimento com IA",
  avaliacoes: "Avaliações e relatórios",
  campanhas: "Campanhas",
  equipe: "Usuários e equipe",
  extensao: "Extensão e assistente",
  cobranca: "Plano e cobrança",
  outro: "Outro assunto",
} as const;
export type SuggestionSubject = keyof typeof SUGGESTION_SUBJECTS;

export const CreateSuggestionRequest = z.object({
  tenantId: z.uuid(),
  text: z.string().trim().min(1, "Escreva a sua sugestão.").max(2000, "Use até 2.000 caracteres."),
});
export type CreateSuggestionRequest = z.infer<typeof CreateSuggestionRequest>;

/** Sugestão como a plataforma vê. `subject` null: a IA ainda não classificou (ou estava fora do ar). */
export type PlatformSuggestionDto = {
  id: string;
  subject: SuggestionSubject | null;
  text: string;
  tenantName: string;
  userName: string;
  createdAt: string;
};

/** Ticket ao suporte como a plataforma vê. `summary`: o resumo da IA; sem ela no ar, o que o parceiro escreveu. */
export type PlatformTicketDto = {
  id: string;
  name: string;
  phone: string;
  summary: string;
  tenantName: string;
  userName: string;
  createdAt: string;
};

/**
 * As LLMs do Atendimento com IA, conferidas na hora: a principal (o Ollama local) e a reserva (ex.: o Claude). Atende a
 * principal se ela está no ar; senão, a reserva. null: não configurada (sem a principal, a IA está desligada).
 */
export type PlatformAiStatusDto = {
  main: { model: string; online: boolean } | null;
  fallback: { provider: "openai" | "anthropic"; model: string; online: boolean } | null;
  checkedAt: string;
};

/** Quem respondeu as chamadas de IA: o Claude (a reserva paga), o Jev (pelo OpenRouter) e a LLM local (sem custo). */
export const AI_USAGE_PROVIDER_LABEL = { CLAUDE: "Claude", JEV: "Jev", LOCAL: "IA local" } as const;
export type AiUsageProvider = keyof typeof AI_USAGE_PROVIDER_LABEL;

export type AiUsageTotals = { calls: number; inputTokens: number; outputTokens: number; costUsd: number };

/**
 * Uso de IA num mês (AAAA-MM, horário de Brasília): o total, cada provedor e os restaurantes, de quem gastou mais.
 * `tenantId` null: a plataforma (o Jev na defesa da API). `providers` do restaurante: só os que ele usou.
 */
export type PlatformAiUsageDto = AiUsageTotals & {
  month: string;
  providers: Record<AiUsageProvider, AiUsageTotals>;
  tenants: (AiUsageTotals & { tenantId: string | null; tenantName: string; providers: Partial<Record<AiUsageProvider, AiUsageTotals>> })[];
};

/** Por que a defesa da API agiu sobre um IP (a regra que disparou). */
export const DEFENSE_REASON_LABEL = {
  sensitive_probe: "Sondagem de arquivo sensível",
  endpoint_enumeration: "Enumeração de endpoints",
  auth_abuse: "Abuso de autenticação",
} as const;
export type DefenseReason = keyof typeof DEFENSE_REASON_LABEL;

/** Como o Jev classificou o caso: uma das regras ou uso legítimo. */
export const DEFENSE_CATEGORY_LABEL = { ...DEFENSE_REASON_LABEL, legitimate: "Uso legítimo" } as const;
export type DefenseCategory = keyof typeof DEFENSE_CATEGORY_LABEL;

/**
 * Análise do Jev: a categoria, a chance de ser ataque (0 a 1) e a conclusão. `reused`: o mesmo padrão já tinha sido
 * analisado, e a conclusão foi reaproveitada sem chamar o Jev de novo.
 */
export type DefenseAnalysisDto = {
  category: DefenseCategory | null;
  attack: number | null;
  conclusion: "attack" | "legitimate" | "uncertain";
  model: string;
  reused: boolean;
};

/**
 * Caso da defesa da API (painel da plataforma), do mais recente ao mais antigo. `banned`: a regra baniu o IP na hora,
 * com prazo; `watched`: a regra baniria, mas a defesa só registra (DEFENSE_MODE=watch); `suspected`: só suspeita, o
 * Jev analisa e a plataforma decide se bane. `active`: o banimento vale agora.
 */
export type DefenseEventDto = {
  id: string;
  createdAt: string;
  ip: string;
  method: string;
  path: string;
  userAgent: string | null;
  reason: DefenseReason;
  action: "banned" | "watched" | "suspected";
  bannedUntil: string | null;
  active: boolean;
  unbannedAt: string | null;
  analysis: { state: "off" } | { state: "pending" } | { state: "failed" } | ({ state: "done" } & DefenseAnalysisDto);
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
