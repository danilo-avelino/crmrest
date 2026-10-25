import { CHANNEL_LABEL, type ReplySuggestionDto } from "@dishdesk/shared";
import { Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import { z } from "zod";
import type { RequestAuth } from "../auth/auth.decorators.js";
import type { AutomationState } from "../automations/automation.js";
import { DatabaseService } from "../core/database.service.js";
import { orderUpdateMessage } from "../orders/forecast.js";
import { latestOrderOf } from "../orders/latest-order.js";
import { withOrderTenants } from "../orders/order-scope.js";
import { orderFactsOf } from "./ai-attendant.service.js";
import { factsOf } from "./ai-review.service.js";
import { LlmClient } from "./llm.client.js";
import { restaurantFacts, toneOf, transcript, WRITING_RULES } from "./prompts.js";

/** Mensagens da conversa (das últimas 12 horas) que a IA lê antes de sugerir, como no atendimento com IA. */
const HISTORY_LIMIT = 30;
const HISTORY_MS = 12 * 60 * 60 * 1000;

export const Suggestion = z.object({ text: z.string().trim().min(1).max(1000).describe("A resposta sugerida para o atendente enviar.") });

export function systemPrompt(restaurant: string, channel: string, settings: unknown): string {
  return `Você sugere a próxima resposta que alguém da equipe do restaurante ${restaurant} vai mandar a um cliente pelo ${channel}. O atendente lê a sugestão, muda o que quiser e envia.
${toneOf(settings)}
${WRITING_RULES}

Regras obrigatórias:
- Responda à última mensagem do cliente, levando em conta a conversa.
- Escreva como alguém da equipe (nós), não como atendente virtual.
- Só afirme o que está nos DADOS ou o que a equipe já disse na conversa. Nunca invente preço, cardápio, prazo, horário, taxa, promoção, endereço, política nem o andamento do pedido.
- Sem a informação, não afirme nada: diga que vai verificar e deixe o atendente completar.
- Não prometa reembolso, desconto, troca nem cancelamento.
- Cumprimente só se ninguém da equipe cumprimentou o cliente na conversa.`;
}

/**
 * Sugestão de resposta (E28): com o campo vazio, o atendente pede à IA uma resposta para a conversa. A sugestão vai para
 * o composer, onde ele edita e envia (e a revisão por IA vale como para qualquer resposta). Nada é enviado aqui.
 */
@Injectable()
export class AiSuggestionService {
  private readonly logger = new Logger(AiSuggestionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly llm: LlmClient,
  ) {}

  async suggest(auth: RequestAuth, conversationId: string, now = new Date()): Promise<ReplySuggestionDto> {
    const context = await this.db.withTenants(auth.scope, async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { id: conversationId },
        select: {
          tenantId: true,
          channelId: true,
          automationState: true,
          contact: true,
          channel: { select: { type: true } },
          tenant: { select: { name: true, settings: true } },
        },
      });
      if (!conversation) throw new NotFoundException("Conversa não encontrada.");
      if (!(await this.llm.activeFor(tx, conversation.tenantId))) throw new NotFoundException("O restaurante não tem o atendimento com IA.");
      const history = (
        await tx.message.findMany({
          where: { conversationId, direction: { in: ["INBOUND", "OUTBOUND"] }, createdAt: { gte: new Date(now.getTime() - HISTORY_MS) } },
          orderBy: { createdAt: "desc" },
          take: HISTORY_LIMIT,
        })
      ).reverse();
      if (!history.some((message) => message.direction === "INBOUND")) {
        throw new UnprocessableEntityException("Ainda não há mensagem do cliente para responder.");
      }
      const settings = conversation.tenant.settings;
      const state = conversation.automationState as AutomationState;
      // O pedido que o cliente confirmou neste atendimento; senão, o mais recente ligado ao cadastro (a confirmar).
      const order = await withOrderTenants(this.db, tx, conversation.channelId, async (orders) => {
        const confirmed = state.linkedOrder ? await orders.order.findUnique({ where: { id: state.linkedOrder.id }, include: { items: true } }) : null;
        const found = confirmed ?? (await latestOrderOf(orders, conversation.contact, now));
        if (!found) return null;
        const channel = await orders.channel.findUniqueOrThrow({ where: { id: found.channelId }, select: { type: true } });
        const update = await orderUpdateMessage(orders, found.id, now, settings);
        return { ...found, confirmed: !!confirmed, byNumber: false, channelType: channel.type, update };
      });
      return { conversation, settings, history, order };
    });

    const { conversation, settings } = context;
    const facts = [restaurantFacts(conversation.tenant.name, settings, now), orderFactsOf(context.order, false)].join("\n");
    const dialogue = transcript(context.history);
    let text: string;
    try {
      ({ text } = await this.llm.json("sugestao", Suggestion, [
        { role: "system", content: systemPrompt(conversation.tenant.name, CHANNEL_LABEL[conversation.channel.type], settings) },
        { role: "user", content: `DADOS\n${facts}\n\nCONVERSA\n${dialogue}` },
      ]));
    } catch (error) {
      this.logger.warn(`Sugestão da conversa ${conversationId} indisponível: ${error instanceof Error ? error.message : String(error)}`);
      throw new ServiceUnavailableException("A IA não conseguiu sugerir uma resposta agora. Tente de novo.");
    }
    // Número, horário, valor, link ou @ que não está nos DADOS nem na conversa foi inventado: a sugestão não vale.
    const known = `${facts}\n${dialogue}`;
    if (!factsOf(text).every((fact) => known.includes(fact))) {
      this.logger.warn(`Sugestão da conversa ${conversationId} com um dado que não está nos DADOS: descartada`);
      throw new ServiceUnavailableException("A IA não conseguiu sugerir uma resposta agora. Tente de novo.");
    }
    return { text };
  }
}
