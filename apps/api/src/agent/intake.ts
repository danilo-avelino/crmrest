import type { OnboardingDto, OnboardingMark, OnboardingStep } from "@dishdesk/shared";
import { z } from "zod";
import { STEP_LABEL } from "./guide.js";

/**
 * As perguntas da implantação, uma por vez e sem LLM (a API fala, o parceiro responde). Terminadas as oito respostas, ou
 * se ele perguntar algo no meio, elas são lidas uma vez por uma chamada só à LLM: o que ele não usa ou deixou no padrão já
 * vira marcação do passo, antes de a IA agir; o resto fica à vista da IA em toda volta.
 */
export const INTAKE_QUESTIONS: { step: OnboardingStep; say: string }[] = [
  { step: "business_hours", say: 'Qual o horário de funcionamento do restaurante? Pode responder "padrão" ou "depois".' },
  { step: "personality", say: 'Qual personalidade de atendimento você prefere: Cordial, Formal, Jovial, Descontraído, Acolhedor ou Direto? (ou "padrão" / "depois")' },
  { step: "order_links", say: 'Qual o link do cardápio para o cliente fazer pedido? (ou "depois")' },
  { step: "members", say: 'Quem vai atender no Dish Desk? Informe o nome e o e-mail de cada pessoa (ou "depois").' },
  { step: "whatsapp", say: "Você atende pelo WhatsApp?" },
  { step: "instagram", say: "Você atende pelo Instagram?" },
  { step: "ifood", say: "Você vende pelo iFood?" },
  { step: "cardapio_web", say: "Você vende pelo Cardápio Web?" },
];

/** Vai antes da primeira pergunta de verdade (que varia: o que já está feito no Dish Desk não é perguntado). */
export const INTAKE_INTRO = "Vou configurar o Dish Desk com você, uma pergunta de cada vez.\n\n";

/** A próxima pergunta: a primeira ainda não feita e que está a fazer no Dish Desk (passo já feito, pulado ou em andamento não se pergunta). */
export function nextQuestion(progress: OnboardingDto | null, asked: OnboardingStep[]) {
  return INTAKE_QUESTIONS.find(
    (question) => !asked.includes(question.step) && (progress?.steps.find((item) => item.step === question.step)?.status ?? "todo") === "todo",
  );
}

/** As respostas, cada uma sob o nome do tópico perguntado: o texto que a LLM classifica e que a IA relê. */
export function answersOf(replies: string[], asked: OnboardingStep[]): string | null {
  const lines = replies.flatMap((reply, index) => (asked[index] ? [`${STEP_LABEL[asked[index]]}: ${reply}`] : []));
  return lines.length ? lines.join("\n") : null;
}

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

export const INTAKE_PROMPT = `Você lê as respostas de um dono de restaurante às perguntas de implantação do Dish Desk (uma linha por tópico: "Tópico: resposta") e classifica cada item. Tópico sem linha é nao_disse.
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
 * Do registro da sessão: se a sessão começou pelas perguntas (`asking`), as respostas do parceiro a elas (`replies`, até
 * a leitura em `intakeDone`) e os sites abertos em aba nova (`login` ou navigate para outro site), para a IA voltar a eles
 * com switch em vez de abrir de novo.
 */
export function extrasOf(events: Row[]): {
  answers: string | null;
  replies: string[];
  asked: OnboardingStep[];
  asking: boolean;
  intakeDone: boolean;
  opened: string[];
} {
  let spoke = false;
  let asking = false;
  const replies: string[] = [];
  const asked: OnboardingStep[] = [];
  let intakeDone = false;
  const opened: string[] = [];
  for (const { kind, content } of events) {
    const value = content as Record<string, unknown>;
    if (kind === "agent") {
      const say = (value.next as { say?: string } | undefined)?.say;
      if (!spoke) asking = say?.startsWith(INTAKE_INTRO) ?? false;
      const question = asking && !intakeDone ? INTAKE_QUESTIONS.find((item) => say === item.say || say === INTAKE_INTRO + item.say) : undefined;
      if (question && !asked.includes(question.step)) asked.push(question.step);
      spoke = true;
      const next = value.next as { type?: string; url?: string; action?: { url?: string; newTab?: boolean } } | undefined;
      const url = next?.type === "login" ? next.url : next?.action?.newTab ? next.action.url : undefined;
      const host = url ? new URL(url).hostname : null;
      if (host && !opened.includes(host)) opened.push(host);
    } else if (kind === "partner" && spoke && asking && !intakeDone && replies.length < asked.length) replies.push(String(value.text));
    else if (kind === "result" && value.intake === true) intakeDone = true;
  }
  return { answers: answersOf(replies, asked), replies, asked, asking, intakeDone, opened };
}
