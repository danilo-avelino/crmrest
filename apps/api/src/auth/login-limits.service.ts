import { HttpException, HttpStatus, Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import { Redis } from "ioredis";
import { ENV, type Env } from "../config/env.js";

/** Senhas erradas seguidas que travam um e-mail, e por quanto tempo (contado da última). */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MS = 15 * 60_000;

export const KEY_PREFIX = "ratelimit:";
// O pacote não exporta o tipo do registro: vem da própria interface.
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage["increment"]>>;
const loginKey = (email: string) => `${KEY_PREFIX}login:${email.toLowerCase()}`;

// Janela fixa: conta as tentativas em KEYS[1] (expira em ttl); passou do limite, bloqueia em KEYS[2] por blockDuration.
const INCREMENT = `
local blocked = redis.call('PTTL', KEYS[2])
if blocked > 0 then return {tonumber(ARGV[2]) + 1, blocked, 1, blocked} end
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], 1, 'PX', ARGV[3])
  return {hits, ttl, 1, tonumber(ARGV[3])}
end
return {hits, ttl, 0, 0}`;

/**
 * Limites de tentativas no Redis, para valerem em todas as réplicas da API e sobreviverem a um restart: o do
 * ThrottlerGuard (por IP) e a trava do login por e-mail, que segura o ataque espalhado por muitos IPs.
 */
@Injectable()
export class LoginLimitsService implements ThrottlerStorage, OnModuleDestroy {
  private readonly redis: Redis;

  constructor(@Inject(ENV) env: Env) {
    this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    const base = `${KEY_PREFIX}${throttlerName}:${key}`;
    const result = await this.redis.eval(INCREMENT, 2, `${base}:hits`, `${base}:block`, ttl, limit, blockDuration);
    const [totalHits, ttlMs, isBlocked, blockMs] = result as [number, number, number, number];
    return {
      totalHits,
      timeToExpire: Math.ceil(ttlMs / 1000),
      isBlocked: isBlocked === 1,
      timeToBlockExpire: Math.ceil(blockMs / 1000),
    };
  }

  /** Recusa o login de um e-mail travado, mesmo com a senha certa. Igual para e-mail com e sem conta. */
  async assertUnlocked(email: string): Promise<void> {
    const failures = Number(await this.redis.get(loginKey(email)));
    if (failures >= LOGIN_MAX_FAILURES) {
      throw new HttpException(
        "Muitas tentativas com este e-mail. Aguarde 15 minutos ou use o “Esqueceu?” para criar uma nova senha.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Conta uma senha errada; devolve se o e-mail acabou de travar. */
  async recordFailure(email: string): Promise<boolean> {
    const [[, failures]] = (await this.redis.multi().incr(loginKey(email)).pexpire(loginKey(email), LOGIN_LOCK_MS).exec()) as [
      [Error | null, number],
    ];
    return failures === LOGIN_MAX_FAILURES;
  }

  /** Login certo ou senha redefinida: o e-mail volta a ter todas as tentativas. */
  async clear(email: string): Promise<void> {
    await this.redis.del(loginKey(email));
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
