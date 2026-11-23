import { InjectQueue, Processor } from "@nestjs/bullmq";
import type { OnModuleInit } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { AiForwardService } from "../ai/ai-forward.service.js";
import { ContactTagsService } from "../contacts/contact-tags.service.js";
import { DatabaseService } from "../core/database.service.js";
import { isDemoTenant } from "../demo/demo.js";
import { DemoService } from "../demo/demo.service.js";
import { AdminNotificationsService } from "../notifications/admin-notifications.service.js";
import { MetaCapiService } from "../funnel/meta-capi.service.js";
import { PublicOrderService } from "../public/public-order.service.js";
import { JobProcessor } from "../queues/job-processor.js";
import { type AdminMessageJob, type AiForwardJob, type AutomationJob, QUEUES } from "../queues/queues.module.js";
import { IfoodAttendanceService } from "./ifood-attendance.service.js";
import { InactivityService } from "./inactivity.service.js";
import { PhoneCollectionService } from "./phone-collection.service.js";
import { ReviewInviteService } from "./review-invite.service.js";
import { tenantPaused } from "./automation.js";
import { SurveyService } from "./survey.service.js";

/**
 * Etapas das automações: lembrete e desistência da coleta de telefone, e o pedido dele no fim do atendimento; pesquisa ao resolver; encerramento por inatividade;
 * mensagem do cliente no chat do iFood; conversas que esperavam um atendente; conversas só com automação já paradas
 * (resolvidas sozinhas). E, de hora em hora, as tags automáticas dos clientes;
 * as notificações ao administrador pelo WhatsApp e, toda segunda, o relatório semanal. A cada minuto, os Pix pendentes
 * do cardápio (F6-06) e os eventos do funil para a Conversions API da Meta (F7-04).
 */
@Processor(QUEUES.automations)
export class AutomationsProcessor extends JobProcessor implements OnModuleInit {
  constructor(
    private readonly phoneCollection: PhoneCollectionService,
    private readonly survey: SurveyService,
    private readonly inactivity: InactivityService,
    private readonly ifoodAttendance: IfoodAttendanceService,
    private readonly contactTags: ContactTagsService,
    private readonly aiForward: AiForwardService,
    private readonly adminNotifications: AdminNotificationsService,
    private readonly reviewInvites: ReviewInviteService,
    private readonly db: DatabaseService,
    private readonly menuOrders: PublicOrderService,
    private readonly capi: MetaCapiService,
    private readonly demo: DemoService,
    @InjectQueue(QUEUES.automations) private readonly automations: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.automations.upsertJobScheduler("menu-pix-sweep", { every: 60_000 }, { name: "menu-pix-sweep" });
    await this.automations.upsertJobScheduler("meta-capi-sweep", { every: 60_000 }, { name: "meta-capi-sweep" });
    // Conta de demonstração: volta ao estado inicial todo dia, com as datas de hoje.
    await this.automations.upsertJobScheduler("demo-reset", { pattern: "0 5 * * *", tz: "America/Sao_Paulo" }, { name: "demo-reset" });
  }

  async process(job: Job<AutomationJob | AiForwardJob | AdminMessageJob>): Promise<void> {
    if (job.name === "contact-tags") return this.contactTags.refreshAll();
    if (job.name === "admin-weekly-report") return this.adminNotifications.weeklyAll();
    if (job.name === "admin-message") return this.adminNotifications.send(job.data as AdminMessageJob);
    if (job.name === "ai-forward-sweep") return this.aiForward.sweep();
    if (job.name === "review-invite-sweep") return this.reviewInvites.sweep();
    if (job.name === "auto-resolve-sweep") return this.inactivity.resolveIdle();
    if (job.name === "menu-pix-sweep") return this.menuOrders.sweepPix();
    if (job.name === "meta-capi-sweep") return this.capi.sweep();
    if (job.name === "demo-reset") return this.demo.resetAll();
    if (job.name === "ai-forward") return this.aiForward.forward(job.data.tenantId);
    const data = job.data as AutomationJob;
    const { tenantId, conversationId } = data;
    // Dish Desk pausado: as etapas agendadas (mesmo as de antes da pausa) não rodam.
    if (await tenantPaused(this.db, tenantId)) return;
    // Conta de demonstração: as automações não rodam, para a conversa seguir só o roteiro da simulação.
    if (await isDemoTenant(this.db, tenantId)) return;
    if (job.name === "phone-reminder") await this.phoneCollection.remind(tenantId, conversationId);
    if (job.name === "phone-give-up") await this.phoneCollection.giveUp(tenantId, conversationId);
    if (job.name === "phone-at-end") await this.phoneCollection.askAtEnd(tenantId, conversationId);
    if (job.name === "survey") await this.survey.request(tenantId, conversationId);
    if (job.name === "inactivity") await this.inactivity.close(tenantId, conversationId);
    if (job.name === "ifood-inbound" && data.ifood) await this.ifoodAttendance.afterInbound(data.ifood.event, data.ifood.orderId);
  }
}
