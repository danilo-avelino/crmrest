import { randomUUID } from "node:crypto";
import type { TenantTx } from "@dishdesk/database";
import type { ModuleKey } from "@dishdesk/database/enums";
import {
  CreateTenantRequest,
  MODULES,
  type PlatformAiStatusDto,
  type PlatformAiUsageDto,
  type PlatformAuditDto,
  type PlatformSuggestionDto,
  type PlatformTenantDto,
  UpdateTenantAccessRequest,
  UpdateTenantModuleRequest,
  type SuggestionSubject,
  UpdateTenantStatusRequest,
} from "@dishdesk/shared";
import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { hasSupabaseAuth, sendInviteEmail } from "../auth/supabase-auth.js";
import { LlmClient } from "../ai/llm.client.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Sugestões que a página da plataforma mostra (as mais recentes). */
const SUGGESTIONS_LIMIT = 2000;

/**
 * Painel da plataforma (Super Admin, E16): todos os restaurantes com o uso de cada um, criação, suspensão, acesso
 * liberado à mão, módulos, a auditoria e as sugestões dos restaurantes. O super admin é conferido no banco a cada chamada (users.is_super_admin), não no token; as políticas
 * RLS da migration super_admin repetem a conferência.
 */
@Controller("platform")
export class PlatformController {
  constructor(
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Env,
    private readonly llm: LlmClient,
  ) {}

  @Get("tenants")
  list(@CurrentAuth() auth: RequestAuth): Promise<PlatformTenantDto[]> {
    return this.tenants(auth.userId);
  }

  @Post("tenants")
  async create(
    @Body(new ZodPipe(CreateTenantRequest)) body: CreateTenantRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<PlatformTenantDto[]> {
    const passwordHash = await hash(body.adminPassword);
    const tenantId = randomUUID();
    // Restaurante e primeiro administrador na mesma transação: nunca fica um restaurante sem admin.
    // E-mail que já tem conta: o acesso fica pendente até a pessoa abrir o convite (a senha informada não vale para ela).
    const pending = await this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      try {
        await tx.tenant.create({ data: { id: tenantId, name: body.name, slug: body.slug }, select: { id: true } });
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") throw new ConflictException("Já existe um restaurante com este endereço.");
        throw error;
      }
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        SELECT app.create_or_restore_member(
          ${randomUUID()}::uuid, ${tenantId}::uuid, ${body.adminName}, ${body.adminEmail}, ${passwordHash}, 'ADMIN'::"TenantRole"
        ) AS id`;
      const member = await tx.tenantMember.findFirst({ where: { tenantId, userId: row?.id }, select: { invitePending: true } });
      if (member?.invitePending && !hasSupabaseAuth(this.env)) {
        throw new ServiceUnavailableException("Este e-mail já tem conta no Dish Desk e precisa aceitar pelo e-mail, mas o convite por e-mail ainda não está disponível.");
      }
      await tx.$executeRaw`SELECT app.log_platform_action('tenant.create', ${tenantId}::uuid)`;
      return member?.invitePending ?? false;
    });
    if (pending && hasSupabaseAuth(this.env)) {
      await sendInviteEmail(this.env, body.adminEmail).catch(() => {
        throw new ServiceUnavailableException('Restaurante criado, mas o e-mail do convite não saiu. Use "Enviar convite" em Configurações → Usuários do restaurante.');
      });
    }
    return this.tenants(auth.userId);
  }

  @Patch("tenants/:tenantId")
  async updateStatus(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(UpdateTenantStatusRequest)) body: UpdateTenantStatusRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<PlatformTenantDto[]> {
    await this.db.withTenants({ tenantIds: [], userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      if (!(await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) {
        throw new NotFoundException("Restaurante não encontrado.");
      }
      await tx.$executeRaw`SELECT app.set_tenant_status(${tenantId}::uuid, ${body.status}::"TenantStatus")`;
    });
    return this.tenants(auth.userId);
  }

  /** Acesso liberado até o fim do dia escolhido (horário de Brasília), com o plano. */
  @Patch("tenants/:tenantId/access")
  async updateAccess(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(UpdateTenantAccessRequest)) body: UpdateTenantAccessRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<PlatformTenantDto[]> {
    const paidUntil = new Date(`${body.paidUntil}T23:59:59.999-03:00`);
    if (paidUntil.getTime() <= Date.now()) throw new UnprocessableEntityException("Escolha uma data a partir de hoje.");
    await this.db.withTenants({ tenantIds: [], userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      const [result] = await tx.$queryRaw<{ granted: boolean }[]>`
        SELECT app.set_tenant_access(${tenantId}::uuid, ${body.plan}::"BillingPlan", ${paidUntil}) AS granted`;
      if (!result?.granted) throw new UnprocessableEntityException("Este restaurante não tem cobrança pelo sistema.");
    });
    return this.tenants(auth.userId);
  }

  @Put("tenants/:tenantId/modules/:module")
  async updateModule(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("module") module: string,
    @Body(new ZodPipe(UpdateTenantModuleRequest)) body: UpdateTenantModuleRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<PlatformTenantDto[]> {
    if (!MODULES.includes(module as ModuleKey)) throw new NotFoundException("Módulo não encontrado.");
    await this.db.withTenants({ tenantIds: [], userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      if (!(await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) {
        throw new NotFoundException("Restaurante não encontrado.");
      }
      await tx.$executeRaw`SELECT app.set_tenant_module(${tenantId}::uuid, ${module}::"ModuleKey", ${body.enabled})`;
    });
    return this.tenants(auth.userId);
  }

  @Get("audit")
  audit(@CurrentAuth() auth: RequestAuth): Promise<PlatformAuditDto[]> {
    return this.db.withTenants({ tenantIds: [], userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      const rows = await tx.$queryRaw<
        {
          id: string;
          action: string;
          user_name: string | null;
          tenant_id: string | null;
          tenant_name: string | null;
          data: PlatformAuditDto["data"];
          created_at: Date;
        }[]
      >`SELECT * FROM app.platform_audit(200)`;
      return rows.map((row) => ({
        id: row.id,
        action: row.action as PlatformAuditDto["action"],
        userName: row.user_name,
        tenantId: row.tenant_id,
        tenantName: row.tenant_name,
        data: row.data,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }

  /** Qual LLM do Atendimento com IA está no ar agora: a principal (local) ou a reserva. */
  @Get("ai-status")
  async aiStatus(@CurrentAuth() auth: RequestAuth): Promise<PlatformAiStatusDto> {
    await this.db.withTenants({ tenantIds: [], userId: auth.userId }, (tx) => requireSuperAdmin(tx, auth.userId));
    return this.llm.status();
  }

  /** Gastos com o Claude num mês (AAAA-MM; sem ele, o mês atual), horário de Brasília: o total e por restaurante. */
  @Get("ai-usage")
  async aiUsage(@CurrentAuth() auth: RequestAuth, @Query("month") month?: string): Promise<PlatformAiUsageDto> {
    const current = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 7);
    const chosen = month ?? current;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(chosen)) throw new UnprocessableEntityException("Mês inválido: use AAAA-MM.");
    const [year, monthNumber] = chosen.split("-").map(Number) as [number, number];
    const from = new Date(`${chosen}-01T00:00:00-03:00`);
    const to = new Date(`${monthNumber === 12 ? year + 1 : year}-${String((monthNumber % 12) + 1).padStart(2, "0")}-01T00:00:00-03:00`);

    const tenants = await this.db.withTenants({ tenantIds: [], userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      return tx.tenant.findMany({ select: { id: true, name: true } });
    });
    const rows = tenants.length
      ? await this.db.withTenants({ tenantIds: tenants.map((t) => t.id), userId: auth.userId }, (tx) =>
          tx.aiUsage.groupBy({
            by: ["tenantId"],
            where: { createdAt: { gte: from, lt: to } },
            _count: { _all: true },
            _sum: { inputTokens: true, outputTokens: true, costMicroUsd: true },
          }),
        )
      : [];
    const names = new Map(tenants.map((t) => [t.id, t.name]));
    const usage = rows
      .map((row) => ({
        tenantId: row.tenantId,
        tenantName: names.get(row.tenantId) ?? "",
        calls: row._count._all,
        inputTokens: row._sum.inputTokens ?? 0,
        outputTokens: row._sum.outputTokens ?? 0,
        costUsd: (row._sum.costMicroUsd ?? 0) / 1_000_000,
      }))
      .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
    return {
      month: chosen,
      costUsd: usage.reduce((sum, row) => sum + row.costUsd, 0),
      calls: usage.reduce((sum, row) => sum + row.calls, 0),
      tenants: usage,
    };
  }

  /** Sugestões dos restaurantes, mais recentes primeiro (a página agrupa por assunto). */
  @Get("suggestions")
  async suggestions(@CurrentAuth() auth: RequestAuth): Promise<PlatformSuggestionDto[]> {
    const tenants = await this.db.withTenants({ tenantIds: [], userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      return tx.tenant.findMany({ select: { id: true, name: true } });
    });
    if (tenants.length === 0) return [];
    const rows = await this.db.withTenants({ tenantIds: tenants.map((t) => t.id), userId: auth.userId }, (tx) =>
      tx.productSuggestion.findMany({
        select: { id: true, tenantId: true, text: true, subject: true, createdAt: true, user: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: SUGGESTIONS_LIMIT,
      }),
    );
    const names = new Map(tenants.map((t) => [t.id, t.name]));
    return rows.map((row) => ({
      id: row.id,
      subject: row.subject as SuggestionSubject | null,
      text: row.text,
      tenantName: names.get(row.tenantId) ?? "",
      userName: row.user.name,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private async tenants(userId: string): Promise<PlatformTenantDto[]> {
    const tenants = await this.db.withTenants({ tenantIds: [], userId }, async (tx) => {
      await requireSuperAdmin(tx, userId);
      return tx.tenant.findMany({
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          createdAt: true,
          trialEndsAt: true,
          paidUntil: true,
          billingPlan: true,
          contactPhone: true,
          taxId: true,
        },
        orderBy: { name: "asc" },
      });
    });
    if (tenants.length === 0) return [];

    // A lista de restaurantes veio do banco, depois de conferir o super admin; as contagens rodam no contexto deles.
    const since = new Date(Date.now() - 30 * DAY_MS);
    const [members, channels, conversations, messages, modules] = await this.db.withTenants(
      { tenantIds: tenants.map((t) => t.id), userId },
      (tx) =>
        Promise.all([
          tx.tenantMember.groupBy({ by: ["tenantId"], where: { isActive: true }, _count: { _all: true } }),
          tx.channel.groupBy({ by: ["tenantId"], where: { status: "CONNECTED" }, _count: { _all: true } }),
          tx.conversation.groupBy({ by: ["tenantId"], where: { status: { in: ["OPEN", "PENDING"] } }, _count: { _all: true } }),
          tx.message.groupBy({ by: ["tenantId"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
          tx.tenantModule.findMany({ select: { tenantId: true, module: true }, orderBy: { module: "asc" } }),
        ]),
    );
    const count = (rows: { tenantId: string; _count: { _all: number } }[]) =>
      new Map(rows.map((row) => [row.tenantId, row._count._all]));
    const [m, c, o, msg] = [count(members), count(channels), count(conversations), count(messages)];

    return tenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      trialEndsAt: t.trialEndsAt?.toISOString() ?? null,
      paidUntil: t.paidUntil?.toISOString() ?? null,
      billingPlan: t.billingPlan,
      modules: modules.filter((row) => row.tenantId === t.id).map((row) => row.module),
      contactPhone: t.contactPhone,
      taxId: t.taxId,
      activeMembers: m.get(t.id) ?? 0,
      connectedChannels: c.get(t.id) ?? 0,
      openConversations: o.get(t.id) ?? 0,
      messagesLast30Days: msg.get(t.id) ?? 0,
    }));
  }
}

async function requireSuperAdmin(tx: TenantTx, userId: string): Promise<void> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { isSuperAdmin: true, isActive: true } });
  if (!user?.isSuperAdmin || !user.isActive) throw new ForbiddenException("Só a equipe da plataforma acessa este painel.");
}
