import { DEFAULT_MENU_ACCENT, menuStoreOf, UpdateMenuStoreRequest } from "@dishdesk/shared";
import type { Prisma } from "@dishdesk/database";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DatabaseService } from "../core/database.service.js";
import { adminScope, memberScope } from "../settings/tenant-admin.js";
import { kindLimits, StorageService, tooBigMessage } from "../storage/storage.service.js";
import { readBody } from "./menu-photo.controller.js";
import { requireModule } from "./menu.service.js";
import { DemoLocked } from "../demo/demo.guard.js";

const uuid = (name: string) => Param(name, ParseUUIDPipe);

/**
 * Dados da loja do cardápio (F2-13), `/menu/:tenantId/store`: endereço, entrega, mínimo, agendamento, marca e contato,
 * guardados em `tenant.settings.menuStore`. A equipe lê; só o administrador altera, com o módulo MENU ligado.
 * Logo e capa só mudam pelo envio do arquivo (`PUT .../logo` e `.../cover`, corpo cru com o `Content-Type` da imagem).
 */
@Controller("menu/:tenantId/store")
export class MenuStoreController {
  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  get(@uuid("tenantId") tenantId: string, @CurrentAuth() auth: RequestAuth) {
    return this.db.withTenants(memberScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true, settings: true } });
      return { slug: tenant.slug, accentDefault: DEFAULT_MENU_ACCENT, store: menuStoreOf(tenant.settings) };
    });
  }

  @Put()
  update(@uuid("tenantId") tenantId: string, @Body(new ZodPipe(UpdateMenuStoreRequest)) body: UpdateMenuStoreRequest, @CurrentAuth() auth: RequestAuth) {
    return this.merge(auth, tenantId, () => body);
  }

  @DemoLocked()
  @Put("logo")
  @HttpCode(200)
  logo(@uuid("tenantId") tenantId: string, @Req() req: Request, @CurrentAuth() auth: RequestAuth) {
    return this.upload(auth, tenantId, req, "logo");
  }

  @DemoLocked()
  @Put("cover")
  @HttpCode(200)
  cover(@uuid("tenantId") tenantId: string, @Req() req: Request, @CurrentAuth() auth: RequestAuth) {
    return this.upload(auth, tenantId, req, "cover");
  }

  private async upload(auth: RequestAuth, tenantId: string, req: Request, field: "logo" | "cover") {
    await this.merge(auth, tenantId, () => ({})); // confere admin e módulo antes de gravar qualquer coisa
    const kind = field === "logo" ? "logo" : "photo";
    const limit = kindLimits(kind).maxBytes;
    const bytes = await readBody(req, limit, tooBigMessage(kind, limit));
    const { key, publicUrl } = await this.storage.put(tenantId, kind, bytes, req.headers["content-type"] ?? "");
    const prop = field === "logo" ? "logoUrl" : "coverUrl";
    let previous: string | undefined;
    try {
      const result = await this.merge(auth, tenantId, (current) => {
        previous = current[prop];
        return { [prop]: publicUrl ?? undefined };
      });
      const old = this.storage.keyFromPublicUrl(previous ?? null);
      if (old) await this.storage.delete(tenantId, old).catch(() => undefined);
      return result;
    } catch (error) {
      await this.storage.delete(tenantId, key).catch(() => undefined);
      throw error;
    }
  }

  /** Troca só `settings.menuStore` (o resto das configurações fica); a logo e a capa atuais são mantidas. */
  private merge(auth: RequestAuth, tenantId: string, patch: (current: ReturnType<typeof menuStoreOf>) => Record<string, unknown>) {
    return this.db.withTenants(adminScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      const { slug, settings } = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true, settings: true } });
      const base = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
      const current = menuStoreOf(settings);
      const next = { ...current, ...patch(current) };
      for (const key of Object.keys(next)) if ((next as Record<string, unknown>)[key] === undefined) delete (next as Record<string, unknown>)[key];
      await tx.tenant.update({ where: { id: tenantId }, data: { settings: { ...base, menuStore: next } as Prisma.InputJsonObject } });
      return { slug, accentDefault: DEFAULT_MENU_ACCENT, store: next };
    });
  }
}
