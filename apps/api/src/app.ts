import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import { Logger } from "nestjs-pino";
import { mountBullBoard } from "./admin/bull-board.js";
import { type Env, hasRole } from "./config/env.js";
import { RedisIoAdapter } from "./realtime/redis-io.adapter.js";

/** Configuração comum ao servidor e aos testes. */
export function configureApp(app: INestApplication, env: Env): INestApplication {
  app.useLogger(app.get(Logger));
  // O Next repassa /api/* para cá: navegador e API ficam na mesma origem.
  app.setGlobalPrefix("api");
  // Os webhooks da Evolution (WhatsApp por QR Code) trazem a miniatura das fotos e arquivos: passam dos 100 KB padrão.
  (app as NestExpressApplication).useBodyParser("json", { limit: "2mb" });
  app.use(cookieParser());
  if (hasRole(env, "api") && env.BULL_BOARD_PASSWORD) {
    mountBullBoard(app, { user: env.BULL_BOARD_USER, password: env.BULL_BOARD_PASSWORD });
  }
  if (hasRole(env, "realtime")) app.useWebSocketAdapter(new RedisIoAdapter(app, env));
  app.enableShutdownHooks();
  return app;
}
