import type { TenantTx } from "@dishdesk/database";
import type { DatabaseService } from "../core/database.service.js";

/**
 * Restaurantes cujos pedidos o atendimento de um canal enxerga: o do canal e os que ele atende (um WhatsApp de grupo,
 * o Instagram de uma rede; Configurações → Integrações). `tx` precisa enxergar o canal.
 */
export async function orderTenantsOf(tx: TenantTx, channelId: string): Promise<string[]> {
  const channel = await tx.channel.findUniqueOrThrow({ where: { id: channelId }, select: { tenantId: true, servedTenantIds: true } });
  return [...new Set([channel.tenantId, ...channel.servedTenantIds])];
}

/**
 * Lê pedidos com o escopo do canal, numa transação própria: nem mais (no painel master, os outros restaurantes do
 * atendente), nem menos (as unidades que o canal atende, mesmo sem acesso do atendente a elas).
 */
export async function withOrderTenants<T>(
  db: DatabaseService,
  tx: TenantTx,
  channelId: string,
  read: (orders: TenantTx, tenantIds: string[]) => Promise<T>,
): Promise<T> {
  const tenantIds = await orderTenantsOf(tx, channelId);
  return db.withTenants({ tenantIds }, (orders) => read(orders, tenantIds));
}
