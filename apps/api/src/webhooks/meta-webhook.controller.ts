import { InjectQueue } from "@nestjs/bullmq";
import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Post,
  Query,
  type RawBodyRequest,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import type { Request } from "express";
import { Public } from "../auth/auth.decorators.js";
import { ENV, type Env } from "../config/env.js";
import { verifyMetaSignature } from "../connectors/meta.js";
import { type InboundJob, QUEUES } from "../queues/queues.module.js";

/** Webhook único da Meta (WhatsApp e Instagram): valida e enfileira, respondendo rápido (§3.5). */
@Public()
@Controller("webhooks/meta")
export class MetaWebhookController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @InjectQueue(QUEUES.inbound) private readonly inbound: Queue<InboundJob>,
  ) {}

  /** Verificação da assinatura do webhook no painel da Meta. */
  @Get()
  @Header("Content-Type", "text/plain")
  verify(@Query() query: Record<string, unknown>): string {
    if (!this.env.META_WEBHOOK_VERIFY_TOKEN) throw new ServiceUnavailableException("Webhook da Meta não configurado.");
    if (query["hub.mode"] !== "subscribe" || query["hub.verify_token"] !== this.env.META_WEBHOOK_VERIFY_TOKEN) {
      throw new ForbiddenException();
    }
    const challenge = query["hub.challenge"];
    return typeof challenge === "string" ? challenge : "";
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers("x-hub-signature-256") signature: string | undefined,
  ): Promise<string> {
    if (!this.env.META_APP_SECRET) throw new ServiceUnavailableException("Webhook da Meta não configurado.");
    const { rawBody } = request;
    const secrets = [this.env.META_APP_SECRET, this.env.INSTAGRAM_APP_SECRET];
    if (!rawBody || !secrets.some((secret) => secret && verifyMetaSignature(rawBody, signature, secret))) {
      throw new UnauthorizedException();
    }
    await this.inbound.add("meta", { source: "meta", payload: request.body as unknown });
    return "EVENT_RECEIVED";
  }
}
