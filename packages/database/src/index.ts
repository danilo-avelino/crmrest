import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "./generated/prisma/client.js";

export * from "./crypto.js";
export * from "./demo.js";
export * from "./generated/prisma/client.js";

export type TenantTx = Prisma.TransactionClient;

/** Quem está agindo: os tenants visíveis e, quando há usuário logado, o id dele. */
export type TenantScope = { tenantIds: string[]; userId?: string };

export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({
    // Conexão ociosa fica 1 min no pool (o padrão do pg é 10 s): cada conexão nova autentica de novo no pooler do
    // Supabase, e é nessa autenticação que ele às vezes responde 08P01 (EAUTHPROTOCOL).
    adapter: new PrismaPg({ connectionString, idleTimeoutMillis: 60_000 }),
    // Padrão do Prisma: 2 s de espera por uma conexão livre e 5 s de transação. Com o banco do Supabase a alguns ms por
    // consulta, transações de muitas consultas passavam dos 5 s por pouco, e num pico a espera de 2 s não bastava.
    transactionOptions: { maxWait: 10_000, timeout: 10_000 },
  });
}

/** Falha ao autenticar a conexão nova no pooler: nada rodou ainda, então dá para tentar de novo. */
function isConnectAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("08P01") || message.includes("EAUTHPROTOCOL");
}

/**
 * Executa `fn` numa transação que só enxerga (e só grava) linhas dos tenants informados.
 * Um id = modo restaurante; vários = painel master. A lista deve vir de TenantMember, nunca do cliente.
 * O contexto vale só para esta transação (set_config local), então não vaza entre conexões do pool.
 */
export async function withTenants<T>(
  prisma: PrismaClient,
  scope: TenantScope,
  fn: (tx: TenantTx) => Promise<T>,
  options?: { timeout?: number },
): Promise<T> {
  let started = false;
  const run = () =>
    prisma.$transaction(async (tx) => {
      // Os casts validam os ids no banco: um valor malformado aborta a transação.
      await tx.$executeRaw`SELECT set_config('app.tenant_ids', ${scope.tenantIds}::uuid[]::text, true),
                                  set_config('app.user_id', coalesce(${scope.userId ?? null}::uuid::text, ''), true)`;
      started = true;
      return fn(tx);
    }, options);
  try {
    return await run();
  } catch (error) {
    // Uma nova tentativa só se a falha foi ao abrir a conexão, antes de `fn` começar (nada foi lido nem gravado).
    if (started || !isConnectAuthError(error)) throw error;
    return run();
  }
}
