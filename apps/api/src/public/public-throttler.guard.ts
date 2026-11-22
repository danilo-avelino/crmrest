import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { Request } from "express";

/**
 * Limite por IP das rotas públicas (`/api/public/*`). Na Railway o IP do visitante vem no X-Real-IP (o mesmo que a
 * defesa usa); sem ele, o endereço da conexão (desenvolvimento e testes).
 */
@Injectable()
export class PublicThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    return clientIp(req as unknown as Request);
  }
}

export function clientIp(request: Request): string {
  const header = request.headers["x-real-ip"];
  return (Array.isArray(header) ? header[0] : header)?.trim() || request.socket.remoteAddress || "";
}
