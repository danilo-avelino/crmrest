import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Emitter } from "@socket.io/redis-emitter";
import { Redis } from "ioredis";
import { ENV, type Env } from "../config/env.js";

export const INBOX_CHANGED = "inbox.changed";
export type InboxChanged = { tenantId: string; conversationId: string };

export function tenantRoom(tenantId: string): string {
  return `tenant:${tenantId}`;
}

/**
 * Publica eventos para os painéis conectados via Redis, de qualquer processo (api, worker...).
 * O evento só diz o que mudou; o painel busca os dados de novo pela API (com a RLS de sempre).
 */
@Injectable()
export class RealtimeEmitter implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly emitter: Emitter;

  constructor(@Inject(ENV) env: Env) {
    this.redis = new Redis(env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: null });
    this.emitter = new Emitter(this.redis);
  }

  inboxChanged(tenantId: string, conversationId: string): void {
    this.emitter.to(tenantRoom(tenantId)).emit(INBOX_CHANGED, { tenantId, conversationId } satisfies InboxChanged);
  }

  /** Health check: o Redis responde? */
  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
