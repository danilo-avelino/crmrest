import { timingSafeEqual } from "node:crypto";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { NextFunction, Request, Response } from "express";
import { QUEUES } from "../queues/queues.module.js";

export const BULL_BOARD_PATH = "/api/admin/filas";

/** Painel das filas para a operação da plataforma (não para os restaurantes), com Basic auth. */
export function mountBullBoard(app: INestApplication, credentials: { user: string; password: string }): void {
  const serverAdapter = new ExpressAdapter().setBasePath(BULL_BOARD_PATH);
  createBullBoard({
    queues: Object.values(QUEUES).map((name) => new BullMQAdapter(app.get<Queue>(getQueueToken(name)))),
    serverAdapter,
  });
  app.use(BULL_BOARD_PATH, basicAuth(credentials), serverAdapter.getRouter());
}

function basicAuth({ user, password }: { user: string; password: string }) {
  const expected = Buffer.from(`Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`);
  return (req: Request, res: Response, next: NextFunction) => {
    const given = Buffer.from(req.headers.authorization ?? "");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
    res.set("WWW-Authenticate", 'Basic realm="Comanda - filas"').status(401).end();
  };
}
