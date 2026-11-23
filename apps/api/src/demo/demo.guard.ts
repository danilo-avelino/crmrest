import { type CanActivate, type ExecutionContext, Injectable, UnprocessableEntityException, UseGuards } from "@nestjs/common";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { DatabaseService } from "../core/database.service.js";
import { DEMO_BLOCKED_MESSAGE, isDemoTenant } from "./demo.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DemoRequest = {
  auth?: RequestAuth;
  params?: Record<string, unknown>;
  body?: unknown;
  query?: Record<string, unknown>;
};

/**
 * Recusa (422) a ação na conta de demonstração: conectar integrações, cobrar, convidar por e-mail, enviar arquivos, pedir
 * à IA... O restaurante é o do `tenantId` da rota, do corpo ou da query; sem ele, o da sessão (quando é um só).
 */
@Injectable()
export class DemoLockGuard implements CanActivate {
  constructor(private readonly db: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<DemoRequest>();
    const body = typeof request.body === "object" && request.body !== null ? (request.body as Record<string, unknown>) : {};
    // O guard roda antes das pipes: um id fora do formato fica para a validação da rota responder.
    const explicit = [request.params?.tenantId, body.tenantId, request.query?.tenantId].find((id): id is string => typeof id === "string" && UUID.test(id));
    const tenantIds = explicit ? [explicit] : request.auth?.scope.tenantIds.length === 1 ? request.auth.scope.tenantIds : [];
    for (const tenantId of tenantIds) {
      if (await isDemoTenant(this.db, tenantId)) throw new UnprocessableEntityException(DEMO_BLOCKED_MESSAGE);
    }
    return true;
  }
}

/** Rota que fala com fora do Dish Desk: indisponível na conta de demonstração. */
export const DemoLocked = () => UseGuards(DemoLockGuard);
