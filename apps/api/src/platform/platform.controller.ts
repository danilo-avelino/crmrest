import { randomUUID } from "node:crypto";
import type { TenantTx } from "@dishdesk/database";
import type { ModuleKey } from "@dishdesk/database/enums";
import {
  CreateTenantRequest,
  type DefenseEventDto,
  MODULES,
  type PlatformAiStatusDto,
  type PlatformAiUsageDto,
  type PlatformAuditDto,
  type PlatformSuggestionDto,
  type PlatformTenantDto,
  type PlatformTicketDto,
  type PlatformTrafficDto,
  type SiteDevice,
  TRAFFIC_PERIODS,
  type TrafficPeriod,
  type TrafficTotals,
  DIRECT_SOURCE,
  trafficInsights,
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
import { DefenseService } from "../defense/defense.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Sugestões que a página da plataforma mostra (as mais recentes). */
const SUGGESTIONS_LIMIT = 2000;
/** Tickets que a página da plataforma mostra (os mais recentes). */
const TICKETS_LIMIT = 500;

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
    private readonly defense: DefenseService,
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
      // O Dish Desk é vendido com a IA: o restaurante já nasce com o atendimento com IA (a plataforma pode desligar).
      await tx.$executeRaw`SELECT app.set_tenant_module(${tenantId}::uuid, 'AI'::"ModuleKey", true)`;
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

  /** Defesa da API: os IPs banidos e as suspeitas, com a análise do Jev, dos mais recentes aos mais antigos. */
  @Get("defense")
  async defenseEvents(@CurrentAuth() auth: RequestAuth): Promise<DefenseEventDto[]> {
    await this.db.withTenants({ tenantIds: [], userId: auth.userId }, (tx) => requireSuperAdmin(tx, auth.userId));
    return this.defense.list();
  }

  @Post("defense/:eventId/unban")
  async unban(@Param("eventId", ParseUUIDPipe) eventId: string, @CurrentAuth() auth: RequestAuth): Promise<DefenseEventDto> {
    await this.db.withTenants({ tenantIds: [], userId: auth.userId }, (tx) => requireSuperAdmin(tx, auth.userId));
    const event = await this.defense.unban(eventId);
    if (!event) throw new NotFoundException("Caso não encontrado.");
    return event;
  }

  @Post("defense/:eventId/ban")
  async ban(@Param("eventId", ParseUUIDPipe) eventId: string, @CurrentAuth() auth: RequestAuth): Promise<DefenseEventDto> {
    await this.db.withTenants({ tenantIds: [], userId: auth.userId }, (tx) => requireSuperAdmin(tx, auth.userId));
    const event = await this.defense.banManually(eventId);
    if (!event) throw new NotFoundException("Caso não encontrado.");
    return event;
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

  /** Tickets ao suporte, mais recentes primeiro: a equipe entra em contato pelo telefone de cada um. */
  @Get("tickets")
  async tickets(@CurrentAuth() auth: RequestAuth): Promise<PlatformTicketDto[]> {
    const tenants = await this.db.withTenants({ tenantIds: [], userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      return tx.tenant.findMany({ select: { id: true, name: true } });
    });
    if (tenants.length === 0) return [];
    const rows = await this.db.withTenants({ tenantIds: tenants.map((t) => t.id), userId: auth.userId }, (tx) =>
      tx.supportTicket.findMany({
        select: { id: true, tenantId: true, name: true, phone: true, summary: true, createdAt: true, user: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: TICKETS_LIMIT,
      }),
    );
    const names = new Map(tenants.map((t) => [t.id, t.name]));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      summary: row.summary,
      tenantName: names.get(row.tenantId) ?? "",
      userName: row.user.name,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** Tráfego do site institucional nos últimos 7, 30 ou 90 dias (horário de Brasília), com o período anterior. */
  @Get("traffic")
  traffic(@CurrentAuth() auth: RequestAuth, @Query("days") daysParam?: string): Promise<PlatformTrafficDto> {
    const days = Number(daysParam ?? 30) as TrafficPeriod;
    if (!TRAFFIC_PERIODS.includes(days)) throw new UnprocessableEntityException("Período inválido: use 7, 30 ou 90 dias.");
    const today = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const from = new Date(new Date(`${today}T00:00:00-03:00`).getTime() - (days - 1) * DAY_MS);
    const previousFrom = new Date(from.getTime() - days * DAY_MS);
    const to = new Date();

    return this.db.withTenants({ tenantIds: [], userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      const totals = async (start: Date, end: Date): Promise<TrafficTotals> => {
        const [visits] = await tx.$queryRaw<{ pageviews: number; visitors: number; cta: number }[]>`
          SELECT count(*) FILTER (WHERE kind = 'PAGEVIEW')::int AS pageviews, count(DISTINCT visitor_id)::int AS visitors,
                 count(*) FILTER (WHERE kind = 'CTA')::int AS cta
          FROM site_visits WHERE created_at >= ${start} AND created_at < ${end}`;
        // Cadastro pelo site = restaurante com teste grátis (os criados pela plataforma ou por quem já tem conta não têm).
        const [signups] = await tx.$queryRaw<{ count: number }[]>`
          SELECT count(*)::int AS count FROM tenants
          WHERE trial_ends_at > created_at AND created_at >= ${start} AND created_at < ${end}`;
        return { pageviews: visits?.pageviews ?? 0, visitors: visits?.visitors ?? 0, ctaClicks: visits?.cta ?? 0, signups: signups?.count ?? 0 };
      };
      const [current, previous, daily, pages, sources, devices, hours] = await Promise.all([
        totals(from, to),
        totals(previousFrom, from),
        tx.$queryRaw<{ date: string; pageviews: number; visitors: number }[]>`
          SELECT to_char(created_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS date,
                 count(*) FILTER (WHERE kind = 'PAGEVIEW')::int AS pageviews, count(DISTINCT visitor_id)::int AS visitors
          FROM site_visits WHERE created_at >= ${from} GROUP BY 1`,
        tx.$queryRaw<{ path: string; pageviews: number; visitors: number }[]>`
          SELECT path, count(*)::int AS pageviews, count(DISTINCT visitor_id)::int AS visitors
          FROM site_visits WHERE kind = 'PAGEVIEW' AND created_at >= ${from}
          GROUP BY path ORDER BY pageviews DESC, path LIMIT 10`,
        tx.$queryRaw<{ source: string; visitors: number }[]>`
          SELECT coalesce(source, ${DIRECT_SOURCE}) AS source, count(DISTINCT visitor_id)::int AS visitors
          FROM site_visits WHERE created_at >= ${from}
          GROUP BY 1 ORDER BY visitors DESC, source LIMIT 8`,
        tx.$queryRaw<{ device: SiteDevice; visitors: number }[]>`
          SELECT lower(device::text) AS device, count(DISTINCT visitor_id)::int AS visitors
          FROM site_visits WHERE created_at >= ${from} GROUP BY 1 ORDER BY visitors DESC`,
        tx.$queryRaw<{ hour: number; pageviews: number }[]>`
          SELECT extract(hour FROM created_at AT TIME ZONE 'America/Sao_Paulo')::int AS hour, count(*)::int AS pageviews
          FROM site_visits WHERE kind = 'PAGEVIEW' AND created_at >= ${from} GROUP BY 1`,
      ]);

      const byDate = new Map(daily.map((row) => [row.date, row]));
      const data: Omit<PlatformTrafficDto, "insights"> = {
        days,
        totals: current,
        previous,
        daily: Array.from({ length: days }, (_, index) => {
          const date = new Date(from.getTime() + index * DAY_MS - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
          return { date, pageviews: byDate.get(date)?.pageviews ?? 0, visitors: byDate.get(date)?.visitors ?? 0 };
        }),
        pages,
        sources,
        devices,
        hours: Array.from({ length: 24 }, (_, hour) => hours.find((row) => row.hour === hour)?.pageviews ?? 0),
      };
      return { ...data, insights: trafficInsights(data) };
    });
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
