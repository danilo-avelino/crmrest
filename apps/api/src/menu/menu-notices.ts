import type { TenantTx } from "@dishdesk/database";
import { Body, Controller, Delete, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DemoLocked } from "../demo/demo.guard.js";
import { brtClock, currentWindowEnd, inSchedule, nextScheduleStart } from "../public/menu-coupons.js";
import { kindLimits, StorageService, tooBigMessage } from "../storage/storage.service.js";
import { readBody } from "./menu-photo.controller.js";
import { MenuService } from "./menu.service.js";

const minute = z.number().int().min(0).max(1_439);

export const NoticeRequest = z
  .object({
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().max(240).transform((value) => value || null).nullish(),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    startMinute: minute.nullish(),
    endMinute: minute.nullish(),
    endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.").nullish(),
    active: z.boolean().optional(),
  })
  .superRefine((n, ctx) => {
    if ((n.startMinute == null) !== (n.endMinute == null)) ctx.addIssue({ code: "custom", path: ["endMinute"], message: "Informe o início e o fim do horário." });
    if (n.startMinute != null && n.startMinute === n.endMinute) ctx.addIssue({ code: "custom", path: ["endMinute"], message: "Início e fim iguais." });
  });
export type NoticeRequest = z.infer<typeof NoticeRequest>;

type NoticeRow = { weekdays: number[]; startMinute: number | null; endMinute: number | null; endsOn: string | null; active: boolean };

export type NoticeStatus =
  | { kind: "LIVE"; until: string | null }
  | { kind: "OUT_OF_HOURS"; nextAt: string | null }
  | { kind: "ENDED"; since: string }
  | { kind: "PAUSED" };

/** No ar, fora do horário (com a volta), encerrado (passou a data) ou pausado. */
export function noticeStatus(n: NoticeRow, now: Date): NoticeStatus {
  if (!n.active) return { kind: "PAUSED" };
  if (n.endsOn && brtClock(now).day > n.endsOn) return { kind: "ENDED", since: n.endsOn };
  const schedule = { ...n, startsOn: null };
  if (!inSchedule(schedule, now)) return { kind: "OUT_OF_HOURS", nextAt: nextScheduleStart(schedule, now)?.toISOString() ?? null };
  return { kind: "LIVE", until: currentWindowEnd(schedule, now)?.toISOString() ?? null };
}

/** Avisos no ar agora, na ordem (o cardápio público mostra em sequência no topo). */
export async function liveNotices(tx: TenantTx, tenantId: string, now: Date) {
  const rows = await tx.menuNotice.findMany({ where: { tenantId, active: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  return rows.filter((n) => noticeStatus(n, now).kind === "LIVE").map(({ id, title, body, photoUrl }) => ({ id, title, body, photoUrl }));
}

/** Avisos no cardápio (board N5): faixas com imagem no topo do cardápio público, nos dias e horários escolhidos. */
@Injectable()
export class MenuNoticesService {
  constructor(private readonly menu: MenuService) {}

  list(auth: RequestAuth, tenantId: string, now = new Date()) {
    return this.menu.read(auth, tenantId, async (tx) => {
      const rows = await tx.menuNotice.findMany({ where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
      return rows.map((row) => ({ ...row, status: noticeStatus(row, now) }));
    });
  }

  save(auth: RequestAuth, tenantId: string, id: string | null, body: NoticeRequest & { photoUrl?: string | null }, now = new Date()) {
    return this.menu.write(auth, tenantId, async (tx) => {
      // Nome de quem desligou, para o "pausado por Ana".
      const pausedBy = body.active === false ? ((await tx.user.findUnique({ where: { id: auth.userId }, select: { name: true } }))?.name.split(" ")[0] ?? null) : null;
      const data = { ...body, ...(body.active === undefined ? {} : { pausedBy }) };
      let row;
      if (id) {
        if (!(await tx.menuNotice.findFirst({ where: { id, tenantId }, select: { id: true } }))) throw new NotFoundException("Aviso não encontrado.");
        row = await tx.menuNotice.update({ where: { id }, data });
      } else {
        const last = await tx.menuNotice.aggregate({ where: { tenantId }, _max: { sortOrder: true } });
        row = await tx.menuNotice.create({ data: { tenantId, ...data, title: body.title, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
      }
      return { ...row, status: noticeStatus(row, now) };
    });
  }

  remove(auth: RequestAuth, tenantId: string, id: string) {
    return this.menu.write(auth, tenantId, async (tx) => {
      const found = await tx.menuNotice.findFirst({ where: { id, tenantId }, select: { photoUrl: true } });
      if (!found) throw new NotFoundException("Aviso não encontrado.");
      await tx.menuNotice.delete({ where: { id } });
      return found;
    });
  }
}

const uuid = (param: string) => Param(param, ParseUUIDPipe);
const ActiveRequest = z.object({ active: z.boolean() });

@Controller("menu/:tenantId/notices")
export class MenuNoticesController {
  constructor(
    private readonly notices: MenuNoticesService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  list(@uuid("tenantId") tenantId: string, @CurrentAuth() auth: RequestAuth) {
    return this.notices.list(auth, tenantId);
  }

  @Post()
  create(@uuid("tenantId") tenantId: string, @Body(new ZodPipe(NoticeRequest)) body: NoticeRequest, @CurrentAuth() auth: RequestAuth) {
    return this.notices.save(auth, tenantId, null, body);
  }

  @Put(":id")
  update(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @Body(new ZodPipe(NoticeRequest)) body: NoticeRequest, @CurrentAuth() auth: RequestAuth) {
    return this.notices.save(auth, tenantId, id, body);
  }

  /** O interruptor do cartão: liga ou desliga sem mexer no resto. */
  @Patch(":id/active")
  setActive(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @Body(new ZodPipe(ActiveRequest)) body: z.infer<typeof ActiveRequest>, @CurrentAuth() auth: RequestAuth) {
    return this.notices.save(auth, tenantId, id, body as NoticeRequest);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @CurrentAuth() auth: RequestAuth) {
    const { photoUrl } = await this.notices.remove(auth, tenantId, id);
    const key = this.storage.keyFromPublicUrl(photoUrl);
    if (key) await this.storage.delete(tenantId, key).catch(() => undefined);
  }

  /** Imagem do aviso: o arquivo no corpo, com o `Content-Type` da imagem (como a foto do item). */
  @DemoLocked()
  @Put(":id/photo")
  @HttpCode(200)
  async photo(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @Req() req: Request, @CurrentAuth() auth: RequestAuth) {
    const before = (await this.notices.list(auth, tenantId)).find((n) => n.id === id);
    if (!before) throw new NotFoundException("Aviso não encontrado.");
    const limit = kindLimits("photo").maxBytes;
    const bytes = await readBody(req, limit, tooBigMessage("photo", limit));
    const { key, publicUrl } = await this.storage.put(tenantId, "photo", bytes, req.headers["content-type"] ?? "");
    try {
      const notice = await this.notices.save(auth, tenantId, id, { photoUrl: publicUrl } as NoticeRequest & { photoUrl: string });
      const old = this.storage.keyFromPublicUrl(before.photoUrl);
      if (old) await this.storage.delete(tenantId, old).catch(() => undefined);
      return notice;
    } catch (error) {
      await this.storage.delete(tenantId, key).catch(() => undefined);
      throw error;
    }
  }
}
