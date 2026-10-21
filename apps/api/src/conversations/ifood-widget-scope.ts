import type { TenantScope } from "@dishdesk/database";
import type { RequestAuth } from "../auth/auth.decorators.js";
import type { DatabaseService } from "../core/database.service.js";

/**
 * Restaurantes do widget do iFood (e da ponte do chat): todos os do usuário, e não só o escolhido no login. O widget
 * guarda a autorização da loja junto com a lista de lojas do init e a apaga quando a lista muda; presa ao contexto, a
 * lista mudava a cada troca de restaurante (ou no painel master) e o widget pedia a autorização de novo. O restaurante do
 * contexto entra também para o acesso de suporte, em que o super admin não é membro.
 */
export async function ifoodWidgetScope(db: DatabaseService, auth: RequestAuth): Promise<TenantScope> {
  const memberships = await db.withTenants({ tenantIds: [], userId: auth.userId }, (tx) =>
    tx.tenantMember.findMany({ where: { userId: auth.userId, isActive: true, tenant: { status: "ACTIVE" } }, select: { tenantId: true } }),
  );
  const tenantIds = new Set([...memberships.map((m) => m.tenantId), ...auth.scope.tenantIds]);
  return { tenantIds: [...tenantIds], userId: auth.userId };
}
