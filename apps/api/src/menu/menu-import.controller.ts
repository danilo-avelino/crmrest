import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { ImportCommitRequest, ImportPreviewRequest, MenuImportService } from "./menu-import.service.js";

/**
 * Importação do cardápio por planilha (F2-09): `/menu/:tenantId/import/csv/preview` mostra o que será criado (com os
 * erros por linha) e `.../commit` grava. Só o administrador, com o módulo MENU. A importação por foto/PDF (F2-10) entra aqui.
 */
@Controller("menu/:tenantId/import/csv")
export class MenuImportController {
  constructor(private readonly imports: MenuImportService) {}

  @Post("preview")
  @HttpCode(200)
  preview(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(ImportPreviewRequest)) body: ImportPreviewRequest,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.imports.preview(auth, tenantId, body);
  }

  @Post("commit")
  @HttpCode(201)
  commit(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(ImportCommitRequest)) body: ImportCommitRequest,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.imports.commit(auth, tenantId, body);
  }
}
