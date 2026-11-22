import { CreateMenuImportRequest, ResolveMenuImportRequest } from "@dishdesk/shared";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { z } from "zod";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { ImportCommitRequest } from "./menu-import.service.js";
import { MenuImportRequestService } from "./menu-import-request.service.js";

/** O restaurante pede a importação do cardápio do iFood (não importa sozinho). Lista: membros; pedir: administrador. */
@Controller("menu/:tenantId/import-requests")
export class MenuImportRequestController {
  constructor(private readonly requests: MenuImportRequestService) {}

  @Get()
  list(@Param("tenantId", ParseUUIDPipe) tenantId: string, @CurrentAuth() auth: RequestAuth) {
    return this.requests.list(auth, tenantId);
  }

  @Post()
  @HttpCode(201)
  create(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(CreateMenuImportRequest)) body: CreateMenuImportRequest,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.requests.create(auth, tenantId, body);
  }
}

const PreviewRequest = z.object({ channelId: z.uuid() });
type PreviewRequest = z.infer<typeof PreviewRequest>;

/** A equipe da plataforma vê os pedidos, lê o catálogo do iFood da loja, revisa e grava no cardápio do restaurante. */
@Controller("platform/menu-import-requests")
export class PlatformMenuImportController {
  constructor(private readonly requests: MenuImportRequestService) {}

  @Get()
  list(@CurrentAuth() auth: RequestAuth) {
    return this.requests.listAll(auth);
  }

  @Post(":id/ifood-preview")
  @HttpCode(200)
  preview(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(PreviewRequest)) body: PreviewRequest, @CurrentAuth() auth: RequestAuth) {
    return this.requests.preview(auth, id, body.channelId);
  }

  @Post(":id/commit")
  @HttpCode(201)
  commit(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(ImportCommitRequest)) body: ImportCommitRequest, @CurrentAuth() auth: RequestAuth) {
    return this.requests.commit(auth, id, body.rows);
  }

  @Post(":id/resolve")
  @HttpCode(200)
  resolve(@Param("id", ParseUUIDPipe) id: string, @Body(new ZodPipe(ResolveMenuImportRequest)) body: ResolveMenuImportRequest, @CurrentAuth() auth: RequestAuth) {
    return this.requests.resolve(auth, id, body);
  }
}
