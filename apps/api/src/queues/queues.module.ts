import { BullModule } from "@nestjs/bullmq";
import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { Env } from "../config/env.js";

/**
 * Filas (§3.1): inbound = webhooks; outbound = envios aos canais; automations = etapas agendadas; ifood = polling;
 * channels = manutenção dos canais (renovação de tokens).
 */
export const QUEUES = {
  inbound: "inbound",
  outbound: "outbound",
  automations: "automations",
  ifood: "ifood",
  channels: "channels",
} as const;

/** Payload bruto de um webhook, como chegou da plataforma. */
export type InboundJob = { source: "meta"; payload: unknown };
export type OutboundJob = { tenantId: string; messageId: string };
export type AutomationJob = { tenantId: string; conversationId: string };

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
          { name: QUEUES.channels },
        ),
      ],
      exports: [BullModule],
    };
  }
}
