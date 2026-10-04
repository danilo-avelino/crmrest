import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "./generated/prisma/client.js";

export * from "./crypto.js";
export * from "./generated/prisma/client.js";

export type TenantTx = Prisma.TransactionClient;

/** Quem está agindo: os tenants visíveis e, quando há usuário logado, o id dele. */
export type TenantScope = { tenantIds: string[]; userId?: string };

export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * Executa `fn` numa transação que só enxerga (e só grava) linhas dos tenants informados.
 * Um id = modo restaurante; vários = painel master. A lista deve vir de TenantMember, nunca do cliente.
 * O contexto vale só para esta transação (set_config local), então não vaza entre conexões do pool.
 */
export function withTenants<T>(
  prisma: PrismaClient,
  scope: TenantScope,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Os casts validam os ids no banco: um valor malformado aborta a transação.
    await tx.$executeRaw`SELECT set_config('app.tenant_ids', ${scope.tenantIds}::uuid[]::text, true),
                                set_config('app.user_id', coalesce(${scope.userId ?? null}::uuid::text, ''), true)`;
    return fn(tx);
  });
}
