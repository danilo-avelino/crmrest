import type { OnboardingDto, OnboardingStep } from "@dishdesk/shared";

/** Nome de cada passo do assistente de configuração (lista lateral, painel da extensão) e o "Próximo:" do aviso da Inbox. */
export const STEP_INFO: Record<OnboardingStep, { label: string; next: string }> = {
  whatsapp: { label: "WhatsApp", next: "conectar o WhatsApp" },
  instagram: { label: "Instagram", next: "conectar o Instagram" },
  ifood: { label: "iFood", next: "conectar o iFood" },
  cardapio_web: { label: "Cardápio Web", next: "conectar o Cardápio Web" },
  business_hours: { label: "Horário de funcionamento", next: "o horário de funcionamento" },
  personality: { label: "Personalidade do atendimento", next: "a personalidade do atendimento" },
  order_links: { label: "Links para fazer pedido", next: "os links para fazer pedido" },
  members: { label: "Convidar os atendentes", next: "convidar os atendentes" },
  first_message: { label: "Pronto", next: "receber a primeira mensagem" },
};

/** Passos feitos: concluídos e pulados contam; em andamento só quando terminar (nota do board). */
export function doneCount(onboarding: OnboardingDto): number {
  return onboarding.steps.filter((item) => item.status === "done" || item.status === "skipped").length;
}

/** O passo em que o assistente continua: o primeiro a fazer ou com erro (senão, o último). */
export function resumeIndex(onboarding: OnboardingDto): number {
  const index = onboarding.steps.findIndex((item) => item.status === "todo" || item.status === "error");
  return index === -1 ? onboarding.steps.length - 1 : index;
}
