import { ForbiddenException } from "@nestjs/common";
import type { RequestAuth } from "../auth/auth.decorators.js";

export function isTenantAdmin(auth: RequestAuth, tenantId: string): boolean {
  return auth.tenants.some((tenant) => tenant.id === tenantId && tenant.role === "ADMIN");
}

/** Configurações e integrações: só o administrador do restaurante altera. */
export function requireTenantAdmin(auth: RequestAuth, tenantId: string): void {
  if (!auth.scope.tenantIds.includes(tenantId) || !isTenantAdmin(auth, tenantId)) {
    throw new ForbiddenException("Só o administrador do restaurante altera as configurações.");
  }
}
