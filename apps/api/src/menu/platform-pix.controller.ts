import type { Prisma } from "@dishdesk/database";
import { menuStoreOf } from "@dishdesk/shared";
import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Put } from "@nestjs/common";
import { z } from "zod";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DatabaseService } from "../core/database.service.js";
import { requireSuperAdmin } from "../platform/platform.controller.js";

const SetRecipient = z.object({ recipientId: z.string().trim().regex(/^re_[A-Za-z0-9]{6,40}$/, "O recebedor da Pagar.me começa com re_.").nullable() });
type SetRecipient = z.infer<typeof SetRecipient>;

export type PlatformPixDto = { tenantId: string; name: string; recipientId: string | null; pixEnabled: boolean };

/**
 * Pix do cardápio por restaurante (F6-01): só a equipe da plataforma liga o recebedor da Pagar.me (a conta para onde vai
 * o dinheiro). O restaurante não muda isso pelo painel, para ninguém trocar a conta de destino.
 */
@Controller("platform/menu-pix")
export class PlatformPixController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async list(@CurrentAuth() auth: RequestAuth): Promise<PlatformPixDto[]> {
    const tenants = await this.db.withTenants({ tenantIds: [], userId: auth.userId }, async (tx) => {
      await requireSuperAdmin(tx, auth.userId);
      return tx.tenant.findMany({ where: { modules: { some: { module: "MENU" } } }, select: { id: true, name: true, settings: true }, orderBy: { name: "asc" } });
    });
    return tenants.map((t) => {
      const store = menuStoreOf(t.settings);
      return { tenantId: t.id, name: t.name, recipientId: store.pixRecipientId ?? null, pixEnabled: store.paymentMethods.includes("pix") };
    });
  }

  @Put(":tenantId")
  async set(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Body(new ZodPipe(SetRecipient)) body: SetRecipient, @CurrentAuth() auth: RequestAuth) {
    await this.db.withTenants({ tenantIds: [], userId: auth.userId }, (tx) => requireSuperAdmin(tx, auth.userId));
    return this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
      if (!tenant) throw new NotFoundException("Restaurante não encontrado.");
      const base = (tenant.settings ?? {}) as Prisma.JsonObject;
      const store = { ...menuStoreOf(tenant.settings) } as Record<string, unknown>;
      if (body.recipientId) store.pixRecipientId = body.recipientId;
      else delete store.pixRecipientId;
      await tx.tenant.update({ where: { id: tenantId }, data: { settings: { ...base, menuStore: store } as Prisma.InputJsonObject } });
      return { recipientId: body.recipientId };
    });
  }
}
