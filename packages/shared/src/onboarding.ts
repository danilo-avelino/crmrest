import type { ChannelType } from "@dishdesk/database/enums";
import { z } from "zod";

/** Passos do assistente de configuração (E30), na ordem: as integrações e, depois, o resto da configuração. */
export const ONBOARDING_STEPS = [
  "whatsapp",
  "instagram",
  "ifood",
  "cardapio_web",
  "business_hours",
  "personality",
  "order_links",
  "members",
  "first_message",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Passos de integração: antes de cada um, o assistente pergunta se o restaurante usa o sistema. */
export const ONBOARDING_INTEGRATIONS = {
  whatsapp: "WHATSAPP",
  instagram: "INSTAGRAM",
  ifood: "IFOOD",
  cardapio_web: "CARDAPIO_WEB",
} as const satisfies Partial<Record<OnboardingStep, string>>;

/**
 * - `todo`: a fazer;
 * - `done`: feito (a integração está conectada, a configuração foi salva ou o admin confirmou o padrão);
 * - `skipped`: o admin respondeu "não" ou "agora não";
 * - `in_progress`: depende de terceiros (ex.: a autorização da loja no Portal do Parceiro iFood);
 * - `error`: a integração está conectada, mas com erro (o assistente diz o que corrigir).
 */
export type OnboardingStepStatus = "todo" | "done" | "skipped" | "in_progress" | "error";

export type OnboardingStepDto = {
  step: OnboardingStep;
  status: OnboardingStepStatus;
  /** Integrações: o nome da conta ou da loja conectada. */
  detail: string | null;
};

export type OnboardingDto = {
  tenantId: string;
  steps: OnboardingStepDto[];
  /** A primeira mensagem de um cliente (o passo "Pronto" comemora mostrando ela). */
  firstMessage: { text: string; channelType: ChannelType; at: string } | null;
  /** Todos os passos estão feitos, pulados ou em andamento, e a primeira mensagem de um cliente chegou. */
  completed: boolean;
  /** Abre sozinho: o admin ainda não abriu o assistente e a configuração não terminou. */
  autoOpen: boolean;
};

/** O que o admin marcou num passo; `null` desfaz (ex.: reabrir uma integração que tinha pulado). */
export const OnboardingMark = z.enum(["skipped", "confirmed", "in_progress"]);
export type OnboardingMark = z.infer<typeof OnboardingMark>;

export const UpdateOnboardingStepRequest = z.object({ mark: OnboardingMark.nullable() });
export type UpdateOnboardingStepRequest = z.infer<typeof UpdateOnboardingStepRequest>;

/** O que fica em `tenant.settings.onboarding`. */
export const OnboardingState = z.object({
  openedAt: z.string().optional(),
  marks: z.partialRecord(z.enum(ONBOARDING_STEPS), OnboardingMark).optional(),
});
export type OnboardingState = z.infer<typeof OnboardingState>;

export function onboardingStateOf(settings: unknown): OnboardingState {
  return z.looseObject({ onboarding: OnboardingState.optional() }).safeParse(settings).data?.onboarding ?? {};
}
