import type { Prisma, TenantTx } from "@dishdesk/database";
import { type AiAttendanceDto, aiFullAutoOf, businessHoursOf, isOpenAt, UpdateAiFullAutoRequest } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Put } from "@nestjs/common";
import type { Queue } from "bullmq";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DatabaseService } from "../core/database.service.js";
import { type AiForwardJob, QUEUES } from "../queues/queues.module.js";
import { PresenceService } from "../realtime/presence.service.js";
import { isTenantAdmin } from "../settings/tenant-admin.js";
import { LlmClient } from "./llm.client.js";

/**
 * Tela inicial da Inbox: o "100% automático" do atendimento com IA (a IA atende tudo e não chama a equipe) e se há quem
 * atenda agora. Toda a equipe vê; só o administrador liga e desliga (é uma configuração do restaurante).
 */
@Controller("ai")
export class AiAttendanceController {
  constructor(
    private readonly db: DatabaseService,
    private readonly presence: PresenceService,
    private readonly llm: LlmClient,
    @InjectQueue(QUEUES.automations) private readonly automations: Queue<AiForwardJob>,
  ) {}

  /** Restaurantes do contexto com o módulo Atendimento com IA. */
  @Get("attendance")
  async list(@CurrentAuth() auth: RequestAuth): Promise<AiAttendanceDto[]> {
    const tenants = await this.db.withTenants(auth.scope, async (tx) => {
      const all = await tx.tenant.findMany({
        where: { id: { in: auth.scope.tenantIds } },
        select: { id: true, name: true, settings: true },
        orderBy: { name: "asc" },
      });
      const active = [];
      for (const tenant of all) if (await this.llm.activeFor(tx, tenant.id)) active.push({ ...tenant, waiting: await waitingCount(tx, tenant.id) });
      return active;
    });
    return Promise.all(tenants.map((tenant) => this.toDto(tenant)));
  }

  @Put(":tenantId/full-auto")
  async setFullAuto(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(UpdateAiFullAutoRequest)) body: UpdateAiFullAutoRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<AiAttendanceDto> {
    if (!auth.scope.tenantIds.includes(tenantId) || !isTenantAdmin(auth, tenantId)) {
      throw new ForbiddenException("Só o administrador do restaurante liga e desliga o 100% automático.");
    }
    const tenant = await this.db.withTenants(auth.scope, async (tx) => {
      if (!(await this.llm.activeFor(tx, tenantId))) throw new NotFoundException("O restaurante não tem o atendimento com IA.");
      const { settings } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const current = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
      const updated = await tx.tenant.update({
        where: { id: tenantId },
        data: { settings: { ...current, aiFullAuto: body.enabled } as Prisma.InputJsonObject },
        select: { id: true, name: true, settings: true },
      });
      return { ...updated, waiting: await waitingCount(tx, tenantId) };
    });
    // Desligado: as conversas que esperavam vão para a equipe (se houver alguém online e o restaurante estiver aberto).
    if (!body.enabled) await this.automations.add("ai-forward", { tenantId });
    return this.toDto(tenant);
  }

  private async toDto(tenant: { id: string; name: string; settings: unknown; waiting: number }): Promise<AiAttendanceDto> {
    const hours = businessHoursOf(tenant.settings);
    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      fullAuto: aiFullAutoOf(tenant.settings),
      closed: hours.enabled && !isOpenAt(hours, new Date()),
      agentsOnline: await this.presence.online(tenant.id),
      waiting: tenant.waiting,
    };
  }
}

function waitingCount(tx: TenantTx, tenantId: string): Promise<number> {
  return tx.conversation.count({ where: { tenantId, status: { not: "RESOLVED" }, automationState: { path: ["aiWaiting"], equals: true } } });
}
