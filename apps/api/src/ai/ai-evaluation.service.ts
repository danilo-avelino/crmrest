import { TEAM_REASONS, type TeamReason } from "@dishdesk/shared";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { z } from "zod";
import { DatabaseService } from "../core/database.service.js";
import type { AiJob } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { LlmClient } from "./llm.client.js";
import { transcript } from "./prompts.js";

/** Espera depois de resolvida: a reação do cliente (a nota da pesquisa, o "obrigado") entra na avaliação. */
export const EVALUATION_DELAY_MS = 5 * 60_000;
/** Mensagens do atendimento que a IA lê (as mais recentes). */
const TRANSCRIPT_LIMIT = 80;

export const Evaluation = z.object({
  resolved: z.boolean().describe("O pedido ou o problema do cliente foi resolvido ou respondido."),
  satisfaction: z.enum(["satisfeito", "insatisfeito", "sem_reacao"]),
  score: z.number().int().min(1).max(5),
  summary: z.string().trim().min(1).max(400).describe("O que o cliente queria e como terminou, em uma ou duas frases."),
  teamReason: z.enum(Object.keys(TEAM_REASONS) as [TeamReason, ...TeamReason[]]),
});

export const SYSTEM_PROMPT = `Você avalia atendimentos de um restaurante a clientes, lendo a conversa inteira. Seja justo e objetivo.
Na conversa, "Restaurante (automação)" são mensagens automáticas; "(IA)", do atendente virtual; "(atendente)", de uma pessoa da equipe. Cada linha começa com o horário.

- resolved: o pedido ou o problema do cliente foi resolvido ou respondido?
- satisfaction: "satisfeito" se o cliente mostrou satisfação (agradeceu, elogiou, deu nota alta); "insatisfeito" se reclamou, se irritou ou deu nota baixa; "sem_reacao" se não dá para saber (ex.: parou de responder).
- score: nota de 1 a 5 para o atendimento, pela reação do cliente:
  5 = resolvido e cliente satisfeito;
  4 = resolvido, sem sinal de insatisfação;
  3 = resolvido em parte, demorado ou não dá para saber;
  2 = não resolvido ou cliente insatisfeito;
  1 = cliente muito insatisfeito ou atendimento ruim (grosseria, informação errada, cliente sem resposta).
- summary: em português, uma ou duas frases: o que o cliente queria e como terminou.
- teamReason: o principal motivo de o atendimento precisar da equipe:
  atraso = reclamação de atraso do pedido;
  problema_pedido = item errado, faltando ou com problema de qualidade;
  troca_reembolso = pediu troca, reembolso ou cancelamento;
  fora_do_cardapio = pergunta que a IA não soube responder;
  pediu_pessoa = o cliente pediu para falar com uma pessoa;
  pedido_grande = encomenda, pedido grande ou evento;
  outro = outro motivo.`;

/** Agenda a avaliação de um atendimento que acabou de ser resolvido (o job confere se o restaurante tem o módulo). */
export async function scheduleEvaluation(queue: Queue<AiJob>, tenantId: string, conversationId: string): Promise<void> {
  await queue.add("evaluate", { tenantId, conversationId }, { delay: EVALUATION_DELAY_MS });
}

/**
 * Avaliação automática (E29): quando a conversa é resolvida e a equipe respondeu ao cliente, a LLM lê o atendimento e
 * registra se o problema foi resolvido, se o cliente ficou satisfeito e uma nota. Sem resposta da equipe, não há chamada
 * de IA: o atendimento só fica registrado. Roda na fila ai, fora do caminho do atendimento.
 */
@Injectable()
export class AiEvaluationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    private readonly llm: LlmClient,
  ) {}

  async evaluate(tenantId: string, conversationId: string): Promise<void> {
    const scope = { tenantIds: [tenantId] };
    const attendance = await this.db.withTenants(scope, async (tx) => {
      if (!(await this.llm.activeFor(tx, tenantId))) return null;
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

    // Uma falha da LLM lança: o BullMQ tenta de novo, sem afetar a conversa.
    const { result, model } = await this.llm.answer(tenantId, "avaliacao", Evaluation, [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: transcript(attendance.messages, { withTime: true }) },
    ]);
    await this.db.withTenants(scope, (tx) =>
      tx.conversationEvaluation.create({
        data: {
          tenantId,
          conversationId,
          userId: attendance.userId,
          resolved: result.resolved,
          satisfied: result.satisfaction === "sem_reacao" ? null : result.satisfaction === "satisfeito",
          score: result.score,
          summary: result.summary,
          teamReason: result.teamReason,
          model,
        },
      }),
    );
    this.realtime.inboxChanged(tenantId, conversationId);
  }
}
