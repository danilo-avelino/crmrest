import { HttpException, HttpStatus, Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Redis } from "ioredis";
import { ENV, type Env } from "../config/env.js";

/** Senhas erradas seguidas que travam um e-mail, e por quanto tempo (contado da última). */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_MS = 15 * 60_000;

export const KEY_PREFIX = "ratelimit:";
const loginKey = (email: string) => `${KEY_PREFIX}login:${email.toLowerCase()}`;

/**
 * Trava do login por e-mail, no Redis (vale em todas as réplicas da API e sobrevive a um restart): segura o ataque
 * espalhado por muitos IPs, que o limite por IP não pega.
 */
@Injectable()
export class LoginLimitsService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(@Inject(ENV) env: Env) {
    this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
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
