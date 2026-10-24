import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";
import { ENV, type Env } from "../config/env.js";

/** Um painel conta como online até este tempo sem renovar a presença (o gateway renova a cada PRESENCE_REFRESH_MS). */
export const PRESENCE_TTL_MS = 2 * 60_000;
export const PRESENCE_REFRESH_MS = 30_000;

const key = (tenantId: string) => `presence:tenant:${tenantId}`;
const WAITING_KEY = "ai:waiting-tenants";

/**
 * Quem da equipe está com o Dish Desk aberto, por restaurante: cada painel conectado ao Socket.IO é um membro do
 * conjunto, com a hora da última renovação. Fica no Redis para o worker (que não tem os sockets) saber se há atendente.
 */
@Injectable()
export class PresenceService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(@Inject(ENV) env: Env) {
    this.redis = new Redis(env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: null });
  }

  /** Painel conectado (ou renovando): online nos restaurantes dele. */
  async join(panelId: string, tenantIds: string[], now = Date.now()): Promise<void> {
    const pipeline = this.redis.pipeline();
    for (const tenantId of tenantIds) pipeline.zadd(key(tenantId), now, panelId).pexpire(key(tenantId), PRESENCE_TTL_MS);
    await pipeline.exec();
  }

  async leave(panelId: string, tenantIds: string[]): Promise<void> {
    const pipeline = this.redis.pipeline();
    for (const tenantId of tenantIds) pipeline.zrem(key(tenantId), panelId);
    await pipeline.exec();
  }

  /** Há alguém da equipe com o Dish Desk aberto? Painéis que pararam de renovar (processo caiu) não contam. */
  async online(tenantId: string, now = Date.now()): Promise<boolean> {
    await this.redis.zremrangebyscore(key(tenantId), "-inf", now - PRESENCE_TTL_MS);
    return (await this.redis.zcard(key(tenantId))) > 0;
  }

  // Restaurantes com conversa esperando um atendente: a varredura do AiForwardService passa por eles.

  async markWaiting(tenantId: string): Promise<void> {
    await this.redis.sadd(WAITING_KEY, tenantId);
  }

  /** Tira o restaurante da lista e devolve se ele estava nela. */
  async takeWaiting(tenantId: string): Promise<boolean> {
    return (await this.redis.srem(WAITING_KEY, tenantId)) > 0;
  }

  waitingTenants(): Promise<string[]> {
    return this.redis.smembers(WAITING_KEY);
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
