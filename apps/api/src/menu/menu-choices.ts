import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DemoLocked } from "../demo/demo.guard.js";
import { kindLimits, StorageService, tooBigMessage } from "../storage/storage.service.js";
import { readBody } from "./menu-photo.controller.js";
import { ensureMenu, MenuService, syncChoice } from "./menu.service.js";

const name = z.string().trim().min(1).max(120);
const cents = z.number().int().min(0).max(100_000_00);
const optionalText = (max: number) => z.string().trim().max(max).transform((value) => value || null).nullish();

export const ChoiceRequest = z.object({
  name,
  kind: z.enum(["HALF", "SIZE", "DRINK", "EXTRA"]).optional(),
  code: optionalText(60),
  costCents: cents.nullish(),
  description: optionalText(2_000),
  active: z.boolean().optional(),
  inStock: z.boolean().optional(),
});
export type ChoiceRequest = z.infer<typeof ChoiceRequest>;
export const ChoicePatch = ChoiceRequest.partial();
export type ChoicePatch = z.infer<typeof ChoicePatch>;
export const ChoiceGroupRequest = z.object({ groupId: z.uuid(), priceCents: cents.optional() });
export type ChoiceGroupRequest = z.infer<typeof ChoiceGroupRequest>;

const CHOICE_SELECT = {
  id: true,
  name: true,
  kind: true,
  code: true,
  costCents: true,
  description: true,
  photoUrl: true,
  active: true,
  inStock: true,
  options: { orderBy: { group: { sortOrder: "asc" } }, select: { id: true, priceCents: true, group: { select: { id: true, name: true } } } },
} as const;

/**
 * Opções da biblioteca (board N1): criadas uma vez e usadas em vários grupos de complementos, com o preço de venda
 * em cada grupo. Nome, pausa e estoque valem para todos os grupos (`syncChoice`).
 */
@Injectable()
export class MenuChoicesService {
  constructor(private readonly menu: MenuService) {}

  list(auth: RequestAuth, tenantId: string) {
    return this.menu.read(auth, tenantId, (tx) => tx.menuChoice.findMany({ where: { tenantId }, orderBy: [{ kind: "asc" }, { name: "asc" }], select: CHOICE_SELECT }));
  }

  create(auth: RequestAuth, tenantId: string, body: ChoiceRequest) {
    return this.menu.write(auth, tenantId, async (tx) => {
      const menuId = await ensureMenu(tx, tenantId);
      return tx.menuChoice.create({ data: { tenantId, menuId, ...body }, select: CHOICE_SELECT });
    });
  }

  update(auth: RequestAuth, tenantId: string, id: string, body: ChoicePatch & { photoUrl?: string | null }) {
    return this.menu.write(auth, tenantId, async (tx) => {
      if (!(await tx.menuChoice.findFirst({ where: { id, tenantId }, select: { id: true } }))) throw new NotFoundException("Opção não encontrada.");
      await tx.menuChoice.update({ where: { id }, data: body });
      await syncChoice(tx, tenantId, id);
      return tx.menuChoice.findFirstOrThrow({ where: { id, tenantId }, select: CHOICE_SELECT });
    });
  }

  /** Exclui da biblioteca e de todos os grupos (cascata). */
  remove(auth: RequestAuth, tenantId: string, id: string) {
    return this.menu.write(auth, tenantId, async (tx) => {
      const found = await tx.menuChoice.findFirst({ where: { id, tenantId }, select: { photoUrl: true } });
      if (!found) throw new NotFoundException("Opção não encontrada.");
      await tx.menuChoice.delete({ where: { id } });
      return found;
    });
  }

  /** "Pôr num grupo": a opção entra no fim do grupo com o preço informado. */
  addToGroup(auth: RequestAuth, tenantId: string, id: string, body: ChoiceGroupRequest) {
    return this.menu.write(auth, tenantId, async (tx) => {
      const choice = await tx.menuChoice.findFirst({ where: { id, tenantId }, select: { id: true, name: true, active: true, inStock: true } });
      if (!choice) throw new NotFoundException("Opção não encontrada.");
      if (!(await tx.menuOptionGroup.findFirst({ where: { id: body.groupId, tenantId }, select: { id: true } }))) throw new NotFoundException("Grupo não encontrado.");
      if (await tx.menuOption.findFirst({ where: { tenantId, groupId: body.groupId, choiceId: id }, select: { id: true } })) {
        throw new BadRequestException("Esta opção já está no grupo.");
      }
      const last = await tx.menuOption.aggregate({ where: { tenantId, groupId: body.groupId }, _max: { sortOrder: true } });
      await tx.menuOption.create({
        data: {
          tenantId,
          groupId: body.groupId,
          choiceId: id,
          name: choice.name,
          active: choice.active,
          soldOut: !choice.inStock,
          priceCents: body.priceCents ?? 0,
          sortOrder: (last._max.sortOrder ?? -1) + 1,
        },
      });
      return tx.menuChoice.findFirstOrThrow({ where: { id, tenantId }, select: CHOICE_SELECT });
    });
  }
}

const uuid = (param: string) => Param(param, ParseUUIDPipe);

/** `/menu/:tenantId/choices`: a biblioteca de opções. A equipe lê; só o administrador altera. */
@Controller("menu/:tenantId/choices")
export class MenuChoicesController {
  constructor(
    private readonly choices: MenuChoicesService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  list(@uuid("tenantId") tenantId: string, @CurrentAuth() auth: RequestAuth) {
    return this.choices.list(auth, tenantId);
  }

  @Post()
  create(@uuid("tenantId") tenantId: string, @Body(new ZodPipe(ChoiceRequest)) body: ChoiceRequest, @CurrentAuth() auth: RequestAuth) {
    return this.choices.create(auth, tenantId, body);
  }

  @Patch(":id")
  update(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @Body(new ZodPipe(ChoicePatch)) body: ChoicePatch, @CurrentAuth() auth: RequestAuth) {
    return this.choices.update(auth, tenantId, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @CurrentAuth() auth: RequestAuth) {
    const { photoUrl } = await this.choices.remove(auth, tenantId, id);
    const key = this.storage.keyFromPublicUrl(photoUrl);
    if (key) await this.storage.delete(tenantId, key).catch(() => undefined);
  }

  @Post(":id/groups")
  addToGroup(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @Body(new ZodPipe(ChoiceGroupRequest)) body: ChoiceGroupRequest, @CurrentAuth() auth: RequestAuth) {
    return this.choices.addToGroup(auth, tenantId, id, body);
  }

  /** Foto da opção: o arquivo no corpo, com o `Content-Type` da imagem (como a foto do item). */
  @DemoLocked()
  @Put(":id/photo")
  @HttpCode(200)
  async photo(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @Req() req: Request, @CurrentAuth() auth: RequestAuth) {
    const before = await this.choices.update(auth, tenantId, id, {});
    const limit = kindLimits("photo").maxBytes;
    const bytes = await readBody(req, limit, tooBigMessage("photo", limit));
    const { key, publicUrl } = await this.storage.put(tenantId, "photo", bytes, req.headers["content-type"] ?? "");
    try {
      const choice = await this.choices.update(auth, tenantId, id, { photoUrl: publicUrl });
      const old = this.storage.keyFromPublicUrl(before.photoUrl);
      if (old) await this.storage.delete(tenantId, old).catch(() => undefined);
      return choice;
    } catch (error) {
      await this.storage.delete(tenantId, key).catch(() => undefined);
      throw error;
    }
  }
}
