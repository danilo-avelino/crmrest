import { Processor } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { JobProcessor } from "../queues/job-processor.js";
import { type AutomationJob, QUEUES } from "../queues/queues.module.js";
import { PhoneCollectionService } from "./phone-collection.service.js";

/** Etapas agendadas das automações (lembrete e desistência da coleta de telefone). */
@Processor(QUEUES.automations)
export class AutomationsProcessor extends JobProcessor {
  constructor(private readonly phoneCollection: PhoneCollectionService) {
    super();
  }

  async process(job: Job<AutomationJob>): Promise<void> {
    const { tenantId, conversationId } = job.data;
    if (job.name === "phone-reminder") await this.phoneCollection.remind(tenantId, conversationId);
    if (job.name === "phone-give-up") await this.phoneCollection.giveUp(tenantId, conversationId);
  }
}
