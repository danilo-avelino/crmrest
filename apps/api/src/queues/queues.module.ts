import { BullModule } from "@nestjs/bullmq";
import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { InboundEvent } from "../automations/automation.js";
import type { Env } from "../config/env.js";

/**
 * Filas (§3.1): inbound = webhooks; outbound = envios aos canais; automations = etapas das automações;
 * ifood e cardapioWeb = polling de pedidos (e, no Cardápio Web, a importação da base de clientes); channels = manutenção dos canais (renovação de tokens);
 * ai = respostas e avaliações da IA (módulo Atendimento com IA), separadas para a LLM não atrasar as automações.
 */
export const QUEUES = {
  inbound: "inbound",
  outbound: "outbound",
  automations: "automations",
  ifood: "ifood",
  cardapioWeb: "cardapio-web",
  channels: "channels",
  ai: "ai",
} as const;

/** Payload bruto de um webhook, como chegou da plataforma. */
export type InboundJob = { source: "meta" | "evolution"; payload: unknown };
export type OutboundJob = { tenantId: string; messageId: string };
/** `ifood`: só no job "ifood-inbound" (mensagem do cliente copiada do chat do iFood, com o pedido da conversa). */
export type AutomationJob = { tenantId: string; conversationId: string; ifood?: { event: InboundEvent; orderId: string } };
/** "ai-forward" (fila automations): as conversas que esperavam um atendente vão para a equipe, se houver alguém. */
export type AiForwardJob = { tenantId: string };
/** "admin-message" (fila automations): notificação ao administrador (alerta ou relatório) para um número dele. */
export type AdminMessageJob = { tenantId: string; phone: string; text: string };
/** Uma página da base de clientes do Cardápio Web; `imported` soma o que as páginas anteriores trouxeram. */
export type CardapioWebImportJob = { tenantId: string; channelId: string; page: number; imported: number };
/** "reply": a IA responde à última mensagem do cliente; "evaluate": a IA avalia o atendimento resolvido. */
export type AiJob = { tenantId: string; conversationId: string };

@Global()
@Module({})
export class QueuesModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: QueuesModule,
      imports: [
        BullModule.forRoot({
          connection: { url: env.REDIS_URL },
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: "exponential", delay: 2_000 },
            removeOnComplete: 1_000,
            removeOnFail: 5_000,
          },
        }),
        BullModule.registerQueue(
          { name: QUEUES.inbound },
          { name: QUEUES.outbound },
          { name: QUEUES.automations },
          { name: QUEUES.ifood },
          { name: QUEUES.cardapioWeb },
          { name: QUEUES.channels },
          { name: QUEUES.ai },
        ),
      ],
      exports: [BullModule],
    };
  }
}
