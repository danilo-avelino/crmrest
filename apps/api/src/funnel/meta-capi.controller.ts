import type { Prisma } from "@dishdesk/database";
import { menuStoreOf } from "@dishdesk/shared";
import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DatabaseService } from "../core/database.service.js";
import { requireModule } from "../menu/menu.service.js";
import { adminScope, memberScope } from "../settings/tenant-admin.js";
import { MetaCapiService, metaCapiOf } from "./meta-capi.service.js";

const SetToken = z.object({
  token: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{20,500}$/, "Cole o token de acesso da Conversions API, sem espaços.")
    .nullable(),
});
type SetToken = z.infer<typeof SetToken>;

export type MetaCapiStatusDto = {
  configured: boolean;
  /** Os 4 últimos caracteres do token, para conferir qual está salvo. */
  last4: string | null;
  pixelConfigured: boolean;
  health: Awaited<ReturnType<MetaCapiService["health"]>>;
};

/**
 * Token da Conversions API (F7-04) e a saúde dos envios (F7-08), em Configurações → Meta Ads. O token entra
 * criptografado e nunca volta: o painel vê só se há um e os 4 últimos caracteres. A equipe lê; só o administrador troca.
 */
@Controller("menu/:tenantId/meta-capi")
export class MetaCapiController {
  constructor(
    private readonly db: DatabaseService,
    private readonly capi: MetaCapiService,
  ) {}

  @Get()
  async get(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Query("horas") horas: string | undefined, @CurrentAuth() auth: RequestAuth): Promise<MetaCapiStatusDto> {
    const settings = await this.db.withTenants(memberScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      return (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } })).settings;
    });
    return this.status(tenantId, settings, horas === "168" ? 168 : 24);
  }

  @Put()
  async set(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Body(new ZodPipe(SetToken)) body: SetToken, @CurrentAuth() auth: RequestAuth): Promise<MetaCapiStatusDto> {
    const settings = await this.db.withTenants(adminScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      const { settings } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const base = (settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}) as Prisma.JsonObject;
      const { metaCapi: _old, ...rest } = base;
      const sealed = this.capi.seal(body.token);
      const next = (sealed ? { ...rest, metaCapi: sealed } : rest) as Prisma.InputJsonObject;
      await tx.tenant.update({ where: { id: tenantId }, data: { settings: next } });
      return next;
    });
    return this.status(tenantId, settings);
  }

  private async status(tenantId: string, settings: unknown, hours = 24): Promise<MetaCapiStatusDto> {
    const saved = metaCapiOf(settings);
    return {
      configured: Boolean(saved.tokenEnc),
      last4: saved.tokenEnc ? (saved.last4 ?? null) : null,
      pixelConfigured: Boolean(menuStoreOf(settings).metaPixelId),
      health: await this.capi.health(tenantId, hours),
    };
  }
}
