import type { Prisma } from "@dishdesk/database";
import { MENU_AGENT_RULES_MAX, menuAgentOf, PERSONALITY_INFO, personalityOf, UpdateMenuAgentRequest } from "@dishdesk/shared";
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { requireModule } from "../menu/menu.service.js";
import { adminScope, memberScope } from "../settings/tenant-admin.js";
import { AgentSimulatorService, SIMULATION_DAILY_LIMIT, SimulateAgentRequest } from "./agent-simulator.service.js";

const uuid = (name: string) => Param(name, ParseUUIDPipe);

/**
 * Configurações do agente de pedidos (C4), `/menu/:tenantId/agent-settings`, guardadas em `tenant.settings.menuAgent`.
 * A equipe lê; só o administrador altera e simula, com o módulo MENU ligado. `POST .../agent-simulate` roda o agente
 * real contra o cardápio real sem gravar nada (ver `AgentSimulatorService`).
 */
@Controller("menu/:tenantId")
export class MenuAgentSettingsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly simulator: AgentSimulatorService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get("agent-settings")
  get(@uuid("tenantId") tenantId: string, @CurrentAuth() auth: RequestAuth) {
    return this.db.withTenants(memberScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
      return this.view(tenant.settings);
    });
  }

  @Put("agent-settings")
  update(@uuid("tenantId") tenantId: string, @Body(new ZodPipe(UpdateMenuAgentRequest)) body: UpdateMenuAgentRequest, @CurrentAuth() auth: RequestAuth) {
    return this.db.withTenants(adminScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      const { settings } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const base = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
      // Nome vazio é "sem nome": a chave não fica guardada.
      const next = { ...body, attendantName: body.attendantName || undefined };
      if (next.attendantName === undefined) delete next.attendantName;
      const saved = { ...base, menuAgent: next } as Prisma.InputJsonObject;
      await tx.tenant.update({ where: { id: tenantId }, data: { settings: saved } });
      return this.view(saved);
    });
  }

  @Post("agent-simulate")
  @HttpCode(200)
  simulate(@uuid("tenantId") tenantId: string, @Body(new ZodPipe(SimulateAgentRequest)) body: SimulateAgentRequest, @CurrentAuth() auth: RequestAuth) {
    return this.simulator.simulate(adminScope(auth, tenantId), tenantId, body);
  }

  private view(settings: unknown) {
    const personality = personalityOf(settings);
    return {
      settings: menuAgentOf(settings),
      personality: { id: personality, label: PERSONALITY_INFO[personality].label },
      /** O teto por conversa quando o restaurante não define o seu. */
      defaultDailyTokens: this.env.MENU_AGENT_DAILY_TOKENS,
      rulesMax: MENU_AGENT_RULES_MAX,
      /** Há chave do Claude neste ambiente: sem ela a simulação responde 503 e o agente não atende. */
      aiConfigured: this.simulator.configured,
      simulationDailyLimit: SIMULATION_DAILY_LIMIT,
    };
  }
}
