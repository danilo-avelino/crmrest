import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { AI_IMPORT_PDF_MAX_BYTES } from "./menu-import-ai.js";
import { MenuImportAiService } from "./menu-import-ai.service.js";
import { ImportCommitRequest } from "./menu-import.service.js";
import { readBody } from "./menu-photo.controller.js";

/**
 * Importação do cardápio por foto ou PDF com IA (F2-10). `POST /menu/:tenantId/import/ai` com o arquivo no corpo (o
 * `Content-Type` dele e o nome em `X-File-Name`, codificado) enfileira a leitura; `GET .../ai/:jobId` mostra o andamento
 * e, no fim, as linhas no formato do CSV; `POST .../ai/check` revalida as linhas editadas. Quem grava é o commit do CSV.
 */
@Controller("menu/:tenantId/import/ai")
export class MenuImportAiController {
  constructor(private readonly imports: MenuImportAiService) {}

  @Post()
  @HttpCode(202)
  async start(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Req() req: Request, @CurrentAuth() auth: RequestAuth) {
    await this.imports.assertAllowed(auth, tenantId);
    const bytes = await readBody(req, AI_IMPORT_PDF_MAX_BYTES);
    let fileName = "cardápio";
    try {
      fileName = decodeURIComponent(String(req.headers["x-file-name"] ?? "")) || fileName;
    } catch {
      // nome mal codificado: fica o padrão
    }
    return this.imports.start(auth, tenantId, bytes, req.headers["content-type"] ?? "", fileName);
  }

  @Post("check")
  @HttpCode(200)
  check(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(ImportCommitRequest)) body: ImportCommitRequest,
    @CurrentAuth() auth: RequestAuth,
  ) {
    return this.imports.check(auth, tenantId, body);
  }

  @Get(":jobId")
  status(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Param("jobId", ParseUUIDPipe) jobId: string, @CurrentAuth() auth: RequestAuth) {
    return this.imports.status(auth, tenantId, jobId);
  }
}
