import { Processor } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { JobProcessor } from "../queues/job-processor.js";
import { type AutomationJob, QUEUES } from "../queues/queues.module.js";
import { InactivityService } from "./inactivity.service.js";
import { PhoneCollectionService } from "./phone-collection.service.js";
import { SurveyService } from "./survey.service.js";

/** Etapas das automações: lembrete e desistência da coleta de telefone; pesquisa ao resolver; encerramento por inatividade. */
@Processor(QUEUES.automations)
export class AutomationsProcessor extends JobProcessor {
  constructor(
    private readonly phoneCollection: PhoneCollectionService,
    private readonly survey: SurveyService,
    private readonly inactivity: InactivityService,
  ) {
    super();
  }

  async process(job: Job<AutomationJob>): Promise<void> {
    const { tenantId, conversationId } = job.data;
    if (job.name === "phone-reminder") await this.phoneCollection.remind(tenantId, conversationId);
    if (job.name === "phone-give-up") await this.phoneCollection.giveUp(tenantId, conversationId);
    if (job.name === "survey") await this.survey.request(tenantId, conversationId);
    if (job.name === "inactivity") await this.inactivity.close(tenantId, conversationId);
  }
}
