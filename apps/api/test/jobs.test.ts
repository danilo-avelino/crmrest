import { getQueueToken } from "@nestjs/bullmq";
import { type INestApplication, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { QUEUES } from "../src/queues/queues.module.js";
import { createTestApp } from "./helpers.js";

describe("jobs que falham", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("registra o job que falhou sem mais tentativas", async () => {
    const error = vi.spyOn(Logger.prototype, "error");
    const queue = app.get<Queue>(getQueueToken(QUEUES.outbound));
    // tenantId inválido: a consulta falha no banco (erro inesperado, não de envio).
    const job = await queue.add("send", { tenantId: "nao-e-uuid", messageId: "nao-e-uuid" }, { attempts: 1 });

    await vi.waitFor(() => expect(error).toHaveBeenCalled(), { timeout: 10_000, interval: 100 });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ queue: QUEUES.outbound, jobId: job.id, tenantId: "nao-e-uuid" }),
      "Job falhou sem mais tentativas",
    );
    error.mockRestore();
  });
});
