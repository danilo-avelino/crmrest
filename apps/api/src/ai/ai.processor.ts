import { Processor } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { JobProcessor } from "../queues/job-processor.js";
import { type AiJob, QUEUES } from "../queues/queues.module.js";
import { AiAttendantService } from "./ai-attendant.service.js";
import { AiEvaluationService } from "./ai-evaluation.service.js";

// Um job por vez: a GPU do LLM local atende uma conversa de cada vez, e mensagens seguidas do mesmo cliente recebem uma resposta só.
@Processor(QUEUES.ai, { concurrency: 1 })
export class AiProcessor extends JobProcessor {
  constructor(
    private readonly attendant: AiAttendantService,
    private readonly evaluation: AiEvaluationService,
  ) {
    super();
  }

  async process(job: Job<AiJob>): Promise<void> {
    const { tenantId, conversationId } = job.data;
    if (job.name === "reply") await this.attendant.reply(tenantId, conversationId);
    if (job.name === "evaluate") await this.evaluation.evaluate(tenantId, conversationId);
  }
}
