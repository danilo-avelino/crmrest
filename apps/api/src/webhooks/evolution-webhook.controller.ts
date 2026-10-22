import { InjectQueue } from "@nestjs/bullmq";
import { Body, Controller, Headers, HttpCode, Inject, Post, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import type { Queue } from "bullmq";
import { Public } from "../auth/auth.decorators.js";
import { ENV, type Env } from "../config/env.js";
import { EVOLUTION_TOKEN_HEADER, verifyEvolutionToken } from "../connectors/evolution.connector.js";
import { type InboundJob, QUEUES } from "../queues/queues.module.js";

/** Webhook da Evolution API (WhatsApp por QR Code): confere o token e enfileira, respondendo rápido (§3.5). */
@Public()
@Controller("webhooks/evolution")
export class EvolutionWebhookController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @InjectQueue(QUEUES.inbound) private readonly inbound: Queue<InboundJob>,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Headers(EVOLUTION_TOKEN_HEADER) token: string | undefined, @Body() payload: unknown): Promise<string> {
    if (!this.env.EVOLUTION_WEBHOOK_TOKEN) throw new ServiceUnavailableException("Webhook da Evolution não configurado.");
    if (!verifyEvolutionToken(token, this.env.EVOLUTION_WEBHOOK_TOKEN)) throw new UnauthorizedException();
    await this.inbound.add("evolution", { source: "evolution", payload });
    return "EVENT_RECEIVED";
  }
}
