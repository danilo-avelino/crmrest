import { BadRequestException, Controller, HttpCode, Param, ParseUUIDPipe, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { kindLimits, StorageService, tooBigMessage } from "../storage/storage.service.js";
import { MenuService } from "./menu.service.js";
import { DemoLocked } from "../demo/demo.guard.js";

const uuid = (name: string) => Param(name, ParseUUIDPipe);

const DRAIN_EXTRA_BYTES = 16 * 1024 * 1024;

/**
 * Lê o corpo cru (o parser de JSON ignora `image/*`), recusando acima do limite de tamanho.
 * Acima do limite o resto do corpo é descartado (até DRAIN_EXTRA_BYTES), para o cliente receber o 400 em vez de a conexão cair.
 */
export async function readBody(req: Request, max: number, tooBig = "Arquivo vazio ou grande demais"): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max + DRAIN_EXTRA_BYTES) break;
    if (size <= max) chunks.push(chunk);
  }
  if (size > max) throw new BadRequestException(tooBig);
  return Buffer.concat(chunks);
}

/**
 * Foto do item (F0-03): `PUT /menu/:tenantId/items/:id/photo` com o arquivo no corpo e o `Content-Type` da imagem.
 * Só o administrador, com o módulo MENU; grava em `tenants/{tenantId}/photo/...` e troca o `photoUrl` do item.
 */
@Controller("menu/:tenantId/items/:id/photo")
export class MenuPhotoController {
  constructor(
    private readonly menu: MenuService,
    private readonly storage: StorageService,
  ) {}

  @DemoLocked()
  @Put()
  @HttpCode(200)
  async upload(@uuid("tenantId") tenantId: string, @uuid("id") id: string, @Req() req: Request, @CurrentAuth() auth: RequestAuth) {
    // Confere admin, módulo e item antes de gravar qualquer coisa.
    const before = await this.menu.updateItem(auth, tenantId, id, {});
    const limit = kindLimits("photo").maxBytes;
    const bytes = await readBody(req, limit, tooBigMessage("photo", limit));
    const { key, publicUrl } = await this.storage.put(tenantId, "photo", bytes, req.headers["content-type"] ?? "");
    try {
      const item = await this.menu.updateItem(auth, tenantId, id, { photoUrl: publicUrl });
      const old = this.storage.keyFromPublicUrl(before.photoUrl);
      if (old) await this.storage.delete(tenantId, old).catch(() => undefined);
      return item;
    } catch (error) {
      await this.storage.delete(tenantId, key).catch(() => undefined);
      throw error;
    }
  }
}
