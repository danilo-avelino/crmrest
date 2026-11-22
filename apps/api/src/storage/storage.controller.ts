import { Controller, Get, Header, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Public } from "../auth/auth.decorators.js";
import { StorageService } from "./storage.service.js";

/**
 * Serve os arquivos do disco local de desenvolvimento (sem Supabase). Fora do disco local responde 404.
 * O bucket público não pede login; o privado só abre com o link assinado (`exp` e `sig`).
 * A chave é remontada das partes da rota e validada pelo mesmo formato do StorageService.
 */
@Controller("storage")
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @Get(":bucket/tenants/:tenantId/:kind/:file")
  @Header("X-Content-Type-Options", "nosniff")
  async read(
    @Param("bucket") bucket: string,
    @Param("tenantId") tenantId: string,
    @Param("kind") kind: string,
    @Param("file") file: string,
    @Query("exp") exp: string | undefined,
    @Query("sig") sig: string | undefined,
    @Res() res: Response,
  ) {
    const { bytes, mime, isPublic } = await this.storage.localRead(bucket, `tenants/${tenantId}/${kind}/${file}`, exp, sig);
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", isPublic ? "public, max-age=86400" : "private, no-store");
    res.send(bytes);
  }
}
