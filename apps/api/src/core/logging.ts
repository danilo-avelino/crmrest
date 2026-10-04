import type { Params } from "nestjs-pino";
import type { RequestAuth } from "../auth/auth.decorators.js";
import type { Env } from "../config/env.js";

/** Logs estruturados (Pino): JSON em produção, legíveis no terminal em desenvolvimento. */
export function loggingOptions(env: Env): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      transport: env.NODE_ENV === "development" ? { target: "pino-pretty", options: { singleLine: true } } : undefined,
      autoLogging: { ignore: (req) => req.url?.startsWith("/api/health") ?? false },
      // Sem headers nem query string: cookies, tokens e o verify token do webhook ficam fora dos logs.
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url.split("?")[0] }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      // Quem fez a requisição (o AuthGuard preenche req.auth): todo log de requisição autenticada leva o tenant.
      customProps: (req) => {
        const auth = (req as { auth?: RequestAuth }).auth;
        if (!auth) return {};
        return auth.mode === "tenant"
          ? { userId: auth.userId, tenantId: auth.scope.tenantIds[0] }
          : { userId: auth.userId, tenantIds: auth.scope.tenantIds };
      },
    },
  };
}
