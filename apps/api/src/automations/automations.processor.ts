import { Processor } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { AiForwardService } from "../ai/ai-forward.service.js";
import { ContactTagsService } from "../contacts/contact-tags.service.js";
import { JobProcessor } from "../queues/job-processor.js";
import { type AiForwardJob, type AutomationJob, QUEUES } from "../queues/queues.module.js";
import { IfoodAttendanceService } from "./ifood-attendance.service.js";
import { InactivityService } from "./inactivity.service.js";
import { PhoneCollectionService } from "./phone-collection.service.js";
import { SurveyService } from "./survey.service.js";

/**
 * Etapas das automações: lembrete e desistência da coleta de telefone; pesquisa ao resolver; encerramento por inatividade;
 * mensagem do cliente no chat do iFood; conversas que esperavam um atendente. E, de hora em hora, as tags automáticas dos clientes.
 */
@Processor(QUEUES.automations)
export class AutomationsProcessor extends JobProcessor {
  constructor(
    private readonly phoneCollection: PhoneCollectionService,
    private readonly survey: SurveyService,
    private readonly inactivity: InactivityService,
    private readonly ifoodAttendance: IfoodAttendanceService,
    private readonly contactTags: ContactTagsService,
    private readonly aiForward: AiForwardService,
  ) {
    super();
  }

  async process(job: Job<AutomationJob | AiForwardJob>): Promise<void> {
    if (job.name === "contact-tags") return this.contactTags.refreshAll();
    if (job.name === "ai-forward-sweep") return this.aiForward.sweep();
    if (job.name === "ai-forward") return this.aiForward.forward(job.data.tenantId);
    const data = job.data as AutomationJob;
    const { tenantId, conversationId } = data;
    if (job.name === "phone-reminder") await this.phoneCollection.remind(tenantId, conversationId);
    if (job.name === "phone-give-up") await this.phoneCollection.giveUp(tenantId, conversationId);
    if (job.name === "survey") await this.survey.request(tenantId, conversationId);
    if (job.name === "inactivity") await this.inactivity.close(tenantId, conversationId);
    if (job.name === "ifood-inbound" && data.ifood) await this.ifoodAttendance.afterInbound(data.ifood.event, data.ifood.orderId);
  }
}
