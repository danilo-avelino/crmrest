import type { TeamReason } from "@dishdesk/shared";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { DatabaseService } from "../core/database.service.js";
import { JevClient, type JevQuestion } from "../defense/jev.client.js";
import type { AiJob } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { transcript } from "./prompts.js";

/** Espera depois de resolvida: a reação do cliente (a nota da pesquisa, o "obrigado") entra na avaliação. */
export const EVALUATION_DELAY_MS = 5 * 60_000;
/** Mensagens do atendimento que a IA lê (as mais recentes). */
const TRANSCRIPT_LIMIT = 80;

/** Como ler a conversa que vai para o Jev (cada linha começa com o horário e diz quem escreveu). */
const READING_GUIDE =
  'Conversa de um restaurante com um cliente. "Restaurante (automação)" são mensagens automáticas; "(IA)", do atendente virtual; "(atendente)", de uma pessoa da equipe. Cada linha começa com o horário.';

/** Do pior para o melhor: a posição na escala mais 1 é a nota. */
const SCORE_LEVELS = [
  "1: cliente muito insatisfeito ou atendimento ruim (grosseria, informação errada, cliente sem resposta).",
  "2: não resolvido ou cliente insatisfeito.",
  "3: resolvido em parte, demorado ou não dá para saber.",
  "4: resolvido, sem sinal de insatisfação.",
  "5: resolvido e cliente satisfeito.",
];

const SATISFACTION = {
  satisfeito: "O cliente mostrou satisfação: agradeceu, elogiou ou deu nota alta.",
  insatisfeito: "O cliente reclamou, se irritou ou deu nota baixa.",
  sem_reacao: "Não dá para saber (por exemplo, o cliente parou de responder).",
};

const TEAM_REASON_CRITERIA: Record<TeamReason, string> = {
  atraso: "Reclamação de atraso do pedido.",
  problema_pedido: "Item errado, faltando ou com problema de qualidade.",
  troca_reembolso: "Pediu troca, reembolso ou cancelamento.",
  fora_do_cardapio: "Pergunta que a IA não soube responder.",
  pediu_pessoa: "O cliente pediu para falar com uma pessoa.",
  pedido_grande: "Encomenda, pedido grande ou evento.",
  outro: "Outro motivo.",
};

/** As perguntas da avaliação ao Jev. */
export const EVALUATION_QUESTIONS = {
  resolved: { type: "noul", instructions: "O pedido ou o problema do cliente foi resolvido ou respondido?" },
  satisfaction: { type: "choice", instructions: "Como o cliente reagiu ao atendimento?", criteria: SATISFACTION },
  score: { type: "score", instructions: "Que nota o atendimento merece, pela reação do cliente? Seja justo e objetivo.", criteria: SCORE_LEVELS },
  teamReason: { type: "choice", instructions: "Qual o principal motivo de o atendimento precisar da equipe?", criteria: TEAM_REASON_CRITERIA },
} satisfies Record<string, JevQuestion>;

/** Agenda a avaliação de um atendimento que acabou de ser resolvido (o job confere se o restaurante tem o módulo). */
export async function scheduleEvaluation(queue: Queue<AiJob>, tenantId: string, conversationId: string): Promise<void> {
  await queue.add("evaluate", { tenantId, conversationId }, { delay: EVALUATION_DELAY_MS });
}

/**
 * Avaliação automática (E29): quando a conversa é resolvida e a equipe respondeu ao cliente, o Jev (modelo de decisão,
 * sem texto) lê o atendimento e registra se o problema foi resolvido, se o cliente ficou satisfeito, uma nota e o motivo
 * de precisar da equipe. Sem resposta da equipe, não há chamada de IA: o atendimento só fica registrado. Roda na fila ai,
 * fora do caminho do atendimento.
 */
@Injectable()
export class AiEvaluationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    private readonly jev: JevClient,
  ) {}

  async evaluate(tenantId: string, conversationId: string): Promise<void> {
    const scope = { tenantIds: [tenantId] };
    const attendance = await this.db.withTenants(scope, async (tx) => {
      if (!this.jev.enabled) return null;
      const module = await tx.tenantModule.findUnique({ where: { tenantId_module: { tenantId, module: "AI" } }, select: { id: true } });
      if (!module) return null;
      const conversation = await tx.conversation.findUnique({ where: { id: conversationId }, select: { status: true } });
      if (conversation?.status !== "RESOLVED") return null; // reaberta: será avaliada quando for resolvida de novo
      // O atendimento é o que veio depois do último já encerrado na conversa: avaliado ou registrado como só da IA.
      const last = { where: { conversationId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } } as const;
      const evaluated = (await tx.conversationEvaluation.findFirst(last))?.createdAt;
      const aiOnly = (await tx.aiOnlyAttendance.findFirst(last))?.createdAt;
      const since = evaluated && aiOnly ? (evaluated > aiOnly ? evaluated : aiOnly) : (evaluated ?? aiOnly);
      const messages = (
        await tx.message.findMany({
          where: { conversationId, direction: { in: ["INBOUND", "OUTBOUND"] }, ...(since && { createdAt: { gt: since } }) },
          orderBy: { createdAt: "desc" },
          take: TRANSCRIPT_LIMIT,
        })
      ).reverse();
      if (!messages.some((message) => message.direction === "INBOUND")) return null; // nada novo do cliente
      const userId = messages.findLast((message) => message.direction === "OUTBOUND" && message.sentByUserId)?.sentByUserId;
      if (!userId) {
        await tx.aiOnlyAttendance.create({ data: { tenantId, conversationId } }); // a equipe não respondeu: sem chamada de IA
        return null;
      }
      return { messages, userId };
    });
    if (!attendance) return;

    // Uma falha do Jev lança: o BullMQ tenta de novo, sem afetar a conversa. A conversa é de um cliente do restaurante:
    // só vai a provedores que não guardam os dados para treino.
    const { answers, model } = await this.jev.decide(
      tenantId,
      { como_ler: READING_GUIDE, conversa: transcript(attendance.messages, { withTime: true }) },
      EVALUATION_QUESTIONS,
      { privateData: true },
    );
    const { resolved, satisfaction, score, teamReason } = answers;
    if (resolved.type !== "noul" || score.type !== "score") throw new Error("O Jev recusou avaliar o atendimento.");
    // Recusa na reação ou no motivo: sem reação e outro motivo, em vez de perder a avaliação.
    const reaction = satisfaction.type === "choice" ? satisfaction.choice : "sem_reacao";
    const reason = teamReason.type === "choice" && teamReason.choice in TEAM_REASON_CRITERIA ? (teamReason.choice as TeamReason) : "outro";
    await this.db.withTenants(scope, (tx) =>
      tx.conversationEvaluation.create({
        data: {
          tenantId,
          conversationId,
          userId: attendance.userId,
          resolved: resolved.noul >= 0.5,
          satisfied: reaction === "satisfeito" ? true : reaction === "insatisfeito" ? false : null,
          score: Math.min(5, Math.max(1, Math.round(score.score) + 1)),
          teamReason: reason,
          model,
        },
      }),
    );
    this.realtime.inboxChanged(tenantId, conversationId);
  }
}
