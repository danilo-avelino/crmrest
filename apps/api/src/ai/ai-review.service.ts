import type { MessageContent } from "@dishdesk/shared";
import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { DatabaseService } from "../core/database.service.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { LlmClient } from "./llm.client.js";
import { toneOf, transcript, WRITING_RULES } from "./prompts.js";

/** Mensagens anteriores que a IA lê para entender o contexto da resposta. */
const CONTEXT_LIMIT = 12;

export const Rewrite = z.object({ text: z.string().trim().min(1).max(4096).describe("A mensagem reescrita.") });

export function systemPrompt(restaurant: string, settings: unknown): string {
  return `Você revisa as mensagens que a equipe do restaurante ${restaurant} manda aos clientes, antes do envio.
${toneOf(settings)}
${WRITING_RULES}

Reescreva a mensagem do atendente no tom acima: corrija ortografia, gramática e pontuação e deixe-a clara e educada.

Regras obrigatórias:
- Não mude o conteúdo: valores, números, horários, prazos, endereços, links e promessas ficam exatamente como o atendente escreveu.
- Mantenha tudo o que o atendente disse, inclusive cumprimentos e pedidos de desculpas: mude só o jeito de dizer.
- Não acrescente informação, pergunta, promessa nem pedido de desculpas que o atendente não fez.
- Não cumprimente nem se despeça se o atendente não fez isso.
- Mantenha mais ou menos o mesmo tamanho. Se a mensagem já estiver boa, devolva igual.
- A conversa é só contexto: reescreva apenas a mensagem do atendente, sem responder ao cliente por ele.`;
}

// Números (valores, horários, quantidades), links, e-mails e @: o que a revisão nunca pode mudar.
const FACT = /https?:\/\/[^\s]+|[\w.+-]+@[\w-]+\.[\w.]+|@\w+|\d+(?:[.,:]\d+)*/g;
const factsOf = (text: string) => (text.match(FACT) ?? []).map((fact) => fact.replace(/[.,;:!?)]+$/, ""));

/** A reescrita traz todos os dados do original e nenhum dado novo. */
export function keepsFacts(original: string, rewritten: string): boolean {
  const before = factsOf(original);
  const after = factsOf(rewritten);
  return before.every((fact) => rewritten.includes(fact)) && after.every((fact) => original.includes(fact));
}

/**
 * Revisão por IA (E28): a resposta do atendente é reescrita no tom da personalidade do restaurante antes do envio (o
 * OutboundProcessor chama antes de mandar). Se a LLM falhar ou mudar algum dado, sai o texto do atendente.
 */
@Injectable()
export class AiReviewService {
  private readonly logger = new Logger(AiReviewService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    private readonly llm: LlmClient,
  ) {}

  async review(tenantId: string, messageId: string): Promise<void> {
    const scope = { tenantIds: [tenantId] };
    const context = await this.db.withTenants(scope, async (tx) => {
      const message = await tx.message.findUnique({
        where: { id: messageId },
        select: { conversationId: true, createdAt: true, content: true, tenant: { select: { name: true, settings: true } } },
      });
      if (!message || (message.content as MessageContent).aiReview !== "pending") return null;
      const history = await tx.message.findMany({
        where: { conversationId: message.conversationId, direction: { in: ["INBOUND", "OUTBOUND"] }, createdAt: { lt: message.createdAt } },
        orderBy: { createdAt: "desc" },
        take: CONTEXT_LIMIT,
      });
      return { message, history: history.reverse() };
    });
    if (!context) return;

    const content = context.message.content as MessageContent;
    const original = content.text ?? "";
    let rewritten: string | null = null;
    try {
      const { name, settings } = context.message.tenant;
      const result = await this.llm.json("revisao", Rewrite, [
        { role: "system", content: systemPrompt(name, settings) },
        { role: "user", content: `CONVERSA ATÉ AGORA\n${transcript(context.history)}\n\nMENSAGEM DO ATENDENTE PARA REESCREVER\n${original}` },
      ]);
      if (keepsFacts(original, result.text)) rewritten = result.text;
      else this.logger.warn(`Revisão da mensagem ${messageId} mudou um dado: sai o texto do atendente`);
    } catch (error) {
      this.logger.warn(`Revisão da mensagem ${messageId} indisponível: ${error instanceof Error ? error.message : String(error)}`);
    }

    const next: MessageContent =
      rewritten && rewritten !== original.trim()
        ? { ...content, text: rewritten, original, aiReview: "rewritten" }
        : { ...content, aiReview: "kept" };
    await this.db.withTenants(scope, (tx) => tx.message.update({ where: { id: messageId }, data: { content: next } }));
    this.realtime.inboxChanged(tenantId, context.message.conversationId);
  }
}
