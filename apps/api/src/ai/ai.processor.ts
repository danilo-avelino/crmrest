import { Processor } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { tenantPaused } from "../automations/automation.js";
import { ContactDuplicateReviewService } from "../contacts/contact-duplicate-review.service.js";
import { DatabaseService } from "../core/database.service.js";
import { isDemoTenant } from "../demo/demo.js";
import { OrderAgentService } from "../menu-agent/order-agent.service.js";
import { JobProcessor } from "../queues/job-processor.js";
import { type AiJob, type DuplicateReviewJob, QUEUES } from "../queues/queues.module.js";
import { AiAttendantService } from "./ai-attendant.service.js";
import { AiEvaluationService } from "./ai-evaluation.service.js";

// Um job por vez: a GPU do LLM local atende uma conversa de cada vez, e mensagens seguidas do mesmo cliente recebem uma resposta só.
@Processor(QUEUES.ai, { concurrency: 1 })
export class AiProcessor extends JobProcessor {
  constructor(
    private readonly attendant: AiAttendantService,
    private readonly evaluation: AiEvaluationService,
    private readonly duplicates: ContactDuplicateReviewService,
    private readonly db: DatabaseService,
    private readonly orderAgent: OrderAgentService,
  ) {
    super();
  }

  async process(job: Job<AiJob | DuplicateReviewJob>): Promise<void> {
    if (job.name === "duplicate-review-sweep") return this.duplicates.sweep();
    const { tenantId } = job.data;
    // Dish Desk pausado: a IA não responde, não avalia nem revisa duplicados (nem o que foi agendado antes da pausa).
    if (await tenantPaused(this.db, tenantId)) return;
    // Conta de demonstração: a IA de verdade não age (as respostas dela são as do roteiro da simulação).
    if (await isDemoTenant(this.db, tenantId)) return;
    if (job.name === "duplicate-review") return this.duplicates.review(job.data as DuplicateReviewJob);
    const { conversationId } = job.data as AiJob;
    // Módulo MENU com cardápio ativo, no WhatsApp: o agente de pedidos responde no lugar do atendente (F4-04).
    if (job.name === "reply") {
      if (await this.orderAgent.handles(tenantId, conversationId)) await this.orderAgent.reply(tenantId, conversationId);
      else await this.attendant.reply(tenantId, conversationId);
    }
    if (job.name === "evaluate") await this.evaluation.evaluate(tenantId, conversationId);
  }
}
