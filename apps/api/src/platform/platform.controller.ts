import { randomBytes, randomUUID } from "node:crypto";
import type { TenantTx } from "@dishdesk/database";
import type { ModuleKey } from "@dishdesk/database/enums";
import {
  AI_FORECAST_BASIS_DAYS,
  type AiUsageProvider,
  type AiUsageTotals,
  CreatePlatformMemberRequest,
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
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UnprocessableEntityException,
} from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { LlmClient } from "../ai/llm.client.js";
import { ZodPipe } from "../common/zod.pipe.js";
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
    // E-mail que já tem conta: ganha o acesso direto (a plataforma não manda convite) e a senha informada não vale para ela.
    await this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      try {
        await tx.tenant.create({ data: { id: tenantId, name: body.name, slug: body.slug }, select: { id: true } });
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") throw new ConflictException("Já existe um restaurante com este endereço.");
        throw error;
      }
      // O Dish Desk é vendido com a IA: o restaurante já nasce com o atendimento com IA (a plataforma pode desligar).
      await tx.$executeRaw`SELECT app.set_tenant_module(${tenantId}::uuid, 'AI'::"ModuleKey", true)`;
      await tx.$queryRaw`
        SELECT app.create_or_restore_member(
          ${randomUUID()}::uuid, ${tenantId}::uuid, ${body.adminName}, ${body.adminEmail}, ${passwordHash}, 'ADMIN'::"TenantRole"
        )`;
      await tx.$executeRaw`SELECT app.log_platform_action('tenant.create', ${tenantId}::uuid)`;
    });
    return this.tenants(auth.userId);
  }

  /**
   * Usuário com acesso aos restaurantes escolhidos, sem convite nem confirmação por e-mail: a plataforma responde por
   * quem adiciona. Quem já tem conta (ou tinha um convite pendente) ganha o acesso na hora e mantém a senha atual.
   */
  @Post("members")
  async addMember(
    @Body(new ZodPipe(CreatePlatformMemberRequest)) body: CreatePlatformMemberRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<PlatformTenantDto[]> {
    const tenantIds = [...new Set(body.tenantIds)];
    const passwordHash = await hash(body.password ?? randomBytes(32).toString("base64url"));
    const newUserId = randomUUID();
    await this.db.withTenants({ tenantIds, userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      if ((await tx.tenant.count({ where: { id: { in: tenantIds } } })) !== tenantIds.length) {
        throw new NotFoundException("Restaurante não encontrado.");
      }
      for (const tenantId of tenantIds) {
        await tx.$queryRaw`
          SELECT app.create_or_restore_member(
            ${newUserId}::uuid, ${tenantId}::uuid, ${body.name}, ${body.email}, ${passwordHash}, ${body.role}::"TenantRole"
          )`;
        const data = JSON.stringify({ email: body.email, role: body.role });
        await tx.$executeRaw`SELECT app.log_platform_action('tenant.member_add', ${tenantId}::uuid, ${data}::jsonb)`;
      }
    });
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

  /**
   * Uso de IA num mês (AAAA-MM; sem ele, o mês atual), horário de Brasília: o Claude, o Jev e a LLM local, no total,
   * por modelo, dia a dia e por restaurante, mais a previsão dos próximos 30 dias. O Jev da defesa da API fica numa
   * linha da plataforma.
   */
  @Get("ai-usage")
  async aiUsage(@CurrentAuth() auth: RequestAuth, @Query("month") month?: string): Promise<PlatformAiUsageDto> {
    const now = Date.now();
    const today = new Date(now - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const current = today.slice(0, 7);
    const chosen = month ?? current;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(chosen)) throw new UnprocessableEntityException("Mês inválido: use AAAA-MM.");
    const [year, monthNumber] = chosen.split("-").map(Number) as [number, number];
    const from = new Date(`${chosen}-01T00:00:00-03:00`);
    const to = new Date(`${monthNumber === 12 ? year + 1 : year}-${String((monthNumber % 12) + 1).padStart(2, "0")}-01T00:00:00-03:00`);
    const basisFrom = new Date(now - AI_FORECAST_BASIS_DAYS * DAY_MS);

    const tenants = await this.db.withTenants({ tenantIds: [], userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      return tx.tenant.findMany({ select: { id: true, name: true } });
    });
    type Row = { day: string; tenant_id: string | null; provider: AiUsageProvider; model: string; calls: number; input: bigint; output: bigint; cost: bigint };
    const { rows, recent } = await this.db.withTenants({ tenantIds: tenants.map((t) => t.id), userId: auth.userId }, async (tx) => ({
      // Por dia (Brasília), restaurante, provedor e modelo. O gasto da plataforma (o Jev na defesa da API) vem sem restaurante.
      rows: await tx.$queryRaw<Row[]>`
        SELECT to_char((created_at AT TIME ZONE 'UTC') - interval '3 hours', 'YYYY-MM-DD') AS day, tenant_id::text AS tenant_id,
          provider::text AS provider, model, count(*)::int AS calls, sum(input_tokens)::bigint AS input,
          sum(output_tokens)::bigint AS output, sum(cost_micro_usd)::bigint AS cost
        FROM ai_usages WHERE created_at >= ${from} AND created_at < ${to} GROUP BY 1, 2, 3, 4
        UNION ALL
        SELECT to_char((created_at AT TIME ZONE 'UTC') - interval '3 hours', 'YYYY-MM-DD'), NULL,
          provider::text, model, count(*)::int, sum(input_tokens)::bigint, sum(output_tokens)::bigint, sum(cost_micro_usd)::bigint
        FROM platform_ai_usages WHERE created_at >= ${from} AND created_at < ${to} GROUP BY 1, 3, 4`,
      recent: [
        ...(await tx.aiUsage.groupBy({ by: ["provider"], where: { createdAt: { gte: basisFrom } }, _sum: { costMicroUsd: true } })),
        ...(await tx.platformAiUsage.groupBy({ by: ["provider"], where: { createdAt: { gte: basisFrom } }, _sum: { costMicroUsd: true } })),
      ],
    }));
    const names = new Map(tenants.map((t) => [t.id, t.name]));
    const zero = (): AiUsageTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    const perProvider = (): Record<AiUsageProvider, AiUsageTotals> => ({ CLAUDE: zero(), JEV: zero(), LOCAL: zero() });
    const add = (into: AiUsageTotals, from: AiUsageTotals) => {
      into.calls += from.calls;
      into.inputTokens += from.inputTokens;
      into.outputTokens += from.outputTokens;
      into.costUsd = Math.round((into.costUsd + from.costUsd) * 1_000_000) / 1_000_000; // em milionésimos, sem resto de ponto flutuante
    };
    const total = zero();
    const providers = perProvider();
    const byTenant = new Map<string | null, PlatformAiUsageDto["tenants"][number]>();
    const byModel = new Map<string, PlatformAiUsageDto["models"][number]>();
    const byDay = new Map<string, Record<AiUsageProvider, AiUsageTotals>>();
    for (const row of rows) {
      const totals = { calls: row.calls, inputTokens: Number(row.input), outputTokens: Number(row.output), costUsd: Number(row.cost) / 1_000_000 };
      const name = row.tenant_id ? (names.get(row.tenant_id) ?? "") : "Plataforma (defesa da API)";
      const tenant = byTenant.get(row.tenant_id) ?? { tenantId: row.tenant_id, tenantName: name, ...zero(), providers: {} };
      byTenant.set(row.tenant_id, tenant);
      add((tenant.providers[row.provider] ??= zero()), totals);
      add(tenant, totals);
      const modelKey = `${row.provider}:${row.model}`;
      const model = byModel.get(modelKey) ?? { provider: row.provider, model: row.model, ...zero() };
      byModel.set(modelKey, model);
      add(model, totals);
      const day = byDay.get(row.day) ?? perProvider();
      byDay.set(row.day, day);
      add(day[row.provider], totals);
      add(providers[row.provider], totals);
      add(total, totals);
    }
    // Do dia 1 ao último do mês; no mês atual, até hoje.
    const lastDay = chosen === current ? Number(today.slice(8, 10)) : new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const days = Array.from({ length: lastDay }, (_, index) => {
      const date = `${chosen}-${String(index + 1).padStart(2, "0")}`;
      return { date, providers: byDay.get(date) ?? perProvider() };
    });
    // Próximos 30 dias: a média diária dos últimos AI_FORECAST_BASIS_DAYS dias × 30.
    const recentMicro: Record<AiUsageProvider, number> = { CLAUDE: 0, JEV: 0, LOCAL: 0 };
    for (const row of recent) recentMicro[row.provider] += row._sum.costMicroUsd ?? 0;
    const project = (micro: number) => Math.round((micro * 30) / AI_FORECAST_BASIS_DAYS) / 1_000_000;
    const forecastProviders = { CLAUDE: project(recentMicro.CLAUDE), JEV: project(recentMicro.JEV), LOCAL: project(recentMicro.LOCAL) };
    const tokens = (row: AiUsageTotals) => row.inputTokens + row.outputTokens;
    const byCost = (a: AiUsageTotals, b: AiUsageTotals) => b.costUsd - a.costUsd || tokens(b) - tokens(a);
    return {
      month: chosen,
      ...total,
      providers,
      models: [...byModel.values()].sort(byCost),
      days,
      forecast: {
        basisDays: AI_FORECAST_BASIS_DAYS,
        costUsd: project(recentMicro.CLAUDE + recentMicro.JEV + recentMicro.LOCAL),
        providers: forecastProviders,
      },
      tenants: [...byTenant.values()].sort(byCost),
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
