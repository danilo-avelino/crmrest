import { OnWorkerEvent, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import * as Sentry from "@sentry/nestjs";
import type { Job } from "bullmq";

const logger = new Logger("Jobs");

/** Processor que registra (log + Sentry) os jobs que falharam de vez, sem mais tentativas. */
export abstract class JobProcessor extends WorkerHost {
  @OnWorkerEvent("failed")
  onFailed(job: Job<{ tenantId?: string }> | undefined, error: Error): void {
    if (job && job.attemptsMade < (job.opts.attempts ?? 1)) return; // o BullMQ ainda vai tentar de novo
    const context = { queue: job?.queueName, jobId: job?.id, jobName: job?.name, tenantId: job?.data.tenantId };
    logger.error({ ...context, err: error }, "Job falhou sem mais tentativas");
    Sentry.captureException(error, { tags: { queue: context.queue, tenantId: context.tenantId }, extra: context });
  }
}
