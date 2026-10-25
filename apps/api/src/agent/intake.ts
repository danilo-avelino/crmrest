import type { OnboardingMark, OnboardingStep } from "@dishdesk/shared";
import { z } from "zod";

/**
 * A primeira resposta do parceiro na implantação (à FIRST_QUESTION), lida uma vez por uma chamada só à LLM: o que ele não
 * usa ou deixou no padrão já vira marcação do passo, antes de a IA agir; o resto fica à vista da IA em toda volta.
 */
const Uses = z.enum(["usa", "nao_usa", "nao_disse"]);
const Setting = z.enum(["informou", "padrao", "depois", "nao_disse"]);

export const Intake = z.object({
  whatsapp: Uses,
  instagram: Uses,
  ifood: Uses,
  cardapio_web: Uses,
  business_hours: Setting,
  personality: Setting,
  order_links: Setting,
  members: Setting,
});
export type Intake = z.infer<typeof Intake>;

export const INTAKE_PROMPT = `Você lê a resposta de um dono de restaurante à pergunta de implantação do Dish Desk e classifica cada item.
Sistemas (whatsapp, instagram, ifood, cardapio_web): usa (ele disse que usa ou citou como usado), nao_usa (disse que não usa ou não tem) ou nao_disse.
Configurações (business_hours, personality, order_links, members): informou (ele deu o dado), padrao (pediu o padrão), depois (deixou para depois) ou nao_disse.
Classifique só pelo que ele escreveu.`;

/** O que a resposta já decide: o que ele não usa ou deixou para depois é pulado; o padrão é mantido. */
export function intakeMarks(intake: Intake): { step: OnboardingStep; mark: OnboardingMark }[] {
  return (Object.entries(intake) as [OnboardingStep, string][]).flatMap(([step, answer]): { step: OnboardingStep; mark: OnboardingMark }[] => {
    if (answer === "nao_usa" || answer === "depois") return [{ step, mark: "skipped" as const }];
    if (answer === "padrao") return [{ step, mark: "confirmed" as const }];
    return [];
  });
}

type Row = { kind: string; content: unknown };

/**
 * Do registro da sessão: a primeira resposta do parceiro depois da primeira fala da IA, se ela já foi lida (`intakeDone`)
 * e os sites abertos em aba nova (`login` ou navigate para outro site), para a IA voltar a eles com switch em vez de abrir de novo.
 */
export function extrasOf(events: Row[]): { answers: string | null; intakeDone: boolean; opened: string[] } {
  let spoke = false;
  let answers: string | null = null;
  let intakeDone = false;
  const opened: string[] = [];
  for (const { kind, content } of events) {
    const value = content as Record<string, unknown>;
    if (kind === "agent") {
      spoke = true;
      const next = value.next as { type?: string; url?: string; action?: { url?: string; newTab?: boolean } } | undefined;
      const url = next?.type === "login" ? next.url : next?.action?.newTab ? next.action.url : undefined;
      const host = url ? new URL(url).hostname : null;
      if (host && !opened.includes(host)) opened.push(host);
    } else if (kind === "partner" && spoke && answers === null) answers = String(value.text);
    else if (kind === "result" && value.intake === true) intakeDone = true;
  }
  return { answers, intakeDone, opened };
}
