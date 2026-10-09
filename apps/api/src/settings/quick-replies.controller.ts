import type { TenantTx } from "@dishdesk/database";
import { type QuickReplyDto, QuickReplyRequest } from "@dishdesk/shared";
import {
  Body,
  ConflictException,
  Controller,
  Delete,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DatabaseService } from "../core/database.service.js";
import { requireTenantAdmin } from "./tenant-admin.js";

const SELECT = { id: true, tenantId: true, shortcut: true, content: true } as const;

/** Respostas rápidas do restaurante (Configurações → Respostas rápidas): a equipe lê em GET /quick-replies; só o admin altera. */
@Controller("settings/:tenantId/quick-replies")
export class QuickRepliesController {
  constructor(private readonly db: DatabaseService) {}

  @Post()
  create(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(QuickReplyRequest)) body: QuickReplyRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<QuickReplyDto> {
    return this.write(auth, tenantId, async (tx) => {
      await assertFreeShortcut(tx, tenantId, body.shortcut);
      return tx.quickReply.create({ data: { tenantId, ...body }, select: SELECT });
    });
  }

  @Patch(":id")
  update(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(QuickReplyRequest)) body: QuickReplyRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<QuickReplyDto> {
    return this.write(auth, tenantId, async (tx) => {
      await requireReply(tx, tenantId, id);
      await assertFreeShortcut(tx, tenantId, body.shortcut, id);
      return tx.quickReply.update({ where: { id }, data: body, select: SELECT });
    });
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<void> {
    await this.write(auth, tenantId, async (tx) => {
      await requireReply(tx, tenantId, id);
      await tx.quickReply.delete({ where: { id } });
    });
  }

  private write<T>(auth: RequestAuth, tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    requireTenantAdmin(auth, tenantId);
    return this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, fn);
  }
}

async function requireReply(tx: TenantTx, tenantId: string, id: string): Promise<void> {
  if (!(await tx.quickReply.findFirst({ where: { id, tenantId }, select: { id: true } }))) {
    throw new NotFoundException("Resposta rápida não encontrada.");
  }
}

async function assertFreeShortcut(tx: TenantTx, tenantId: string, shortcut: string, exceptId?: string): Promise<void> {
  const taken = await tx.quickReply.findFirst({ where: { tenantId, shortcut, ...(exceptId && { id: { not: exceptId } }) } });
  if (taken) throw new ConflictException(`Já existe uma resposta com o atalho /${shortcut}.`);
}
