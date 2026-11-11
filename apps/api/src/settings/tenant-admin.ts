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

/**
 * Escopo de um restaurante vindo da requisição (URL, query, corpo), para `withTenants`. A RLS confia na lista que recebe:
 * um id que não foi conferido abre outro restaurante, então nunca monte `{ tenantIds: [tenantId] }` à mão a partir dele.
 */
export function memberScope(auth: RequestAuth, tenantId: string) {
  if (!auth.scope.tenantIds.includes(tenantId)) throw new ForbiddenException("Sem acesso a este restaurante.");
  return { tenantIds: [tenantId], userId: auth.userId };
}

/** Como `memberScope`, para o que só o administrador do restaurante faz. */
export function adminScope(auth: RequestAuth, tenantId: string) {
  requireTenantAdmin(auth, tenantId);
  return { tenantIds: [tenantId], userId: auth.userId };
}

/**
 * Como `adminScope`, aceitando `"all"`: todos os restaurantes do contexto em que quem pede é administrador (relatórios
 * do painel master). Sem nenhum, recusa.
 */
export function adminScopeOf(auth: RequestAuth, choice: string) {
  if (choice !== "all") return adminScope(auth, choice);
  const tenantIds = auth.scope.tenantIds.filter((tenantId) => isTenantAdmin(auth, tenantId));
  if (tenantIds.length === 0) throw new ForbiddenException("Só o administrador do restaurante vê os relatórios.");
  return { tenantIds, userId: auth.userId };
}
