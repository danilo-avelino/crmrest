import { isDemoSettings } from "@dishdesk/database";
import { UnprocessableEntityException } from "@nestjs/common";
import type { DatabaseService } from "../core/database.service.js";

/**
 * Conta de demonstração (apresentações de venda): o restaurante com `settings.demo = true` (só o seed da demo grava a
 * marca). Nada dela sai do Dish Desk: sem mensagens nos canais, sem avisos ao gestor, sem chamadas de IA, sem e-mail,
 * sem pagamento e sem chamadas às plataformas de pedido. Cada ponto que falaria com fora confere aqui antes.
 */
export const DEMO_BLOCKED_MESSAGE = "Indisponível na conta de demonstração.";

export class DemoBlockedError extends Error {
  constructor(what: string) {
    super(`${what}: ${DEMO_BLOCKED_MESSAGE}`);
  }
}

/** A marca muda só quando o seed roda: um minuto de cache poupa uma consulta em cada envio e em cada job. */
const CACHE_MS = 60_000;
const cache = new Map<string, { demo: boolean; at: number }>();

export async function isDemoTenant(db: DatabaseService, tenantId: string): Promise<boolean> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.demo;
  const tenant = await db.withTenants({ tenantIds: [tenantId] }, (tx) =>
    tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }),
  );
  const demo = isDemoSettings(tenant?.settings);
  cache.set(tenantId, { demo, at: Date.now() });
  return demo;
}

/** Para o que falaria com fora (IA, plataformas, pagamento): na demo, recusa com DemoBlockedError. */
export async function assertNotDemo(db: DatabaseService, tenantId: string, what: string): Promise<void> {
  if (await isDemoTenant(db, tenantId)) throw new DemoBlockedError(what);
}

/** Para as ações pedidas pelo painel: na demo, responde 422 com o motivo. */
export async function rejectDemo(db: DatabaseService, tenantId: string): Promise<void> {
  if (await isDemoTenant(db, tenantId)) throw new UnprocessableEntityException(DEMO_BLOCKED_MESSAGE);
}

/** Tira a demo das varreduras que passam por todos os restaurantes (polling, convites, relatórios, renovação de token). */
export async function withoutDemo<T>(db: DatabaseService, rows: T[], tenantOf: (row: T) => string): Promise<T[]> {
  const kept: T[] = [];
  for (const row of rows) if (!(await isDemoTenant(db, tenantOf(row)))) kept.push(row);
  return kept;
}
