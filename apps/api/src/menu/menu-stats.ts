import type { TenantTx } from "@dishdesk/database";

export type TopItem = { itemId: string; name: string; categoryId: string; quantity: number; revenueCents: number };

/**
 * Mais vendidos do cardápio (F2-11): quantidade e receita por item nos últimos `days` dias, do maior para o menor.
 * Calculado na hora a partir de `order_items.menu_item_id` (só o cardápio próprio preenche) nos pedidos não cancelados:
 * o pedido do cardápio nasce pago, ou confirmado quando o pagamento é na entrega (PLANO C5). Sem tabela agregada: o
 * filtro por restaurante e período corta antes do join, então a consulta lê só os pedidos do período do restaurante.
 * `tenantId` filtra explicitamente além da RLS (nunca confie só em uma das duas). Itens arquivados contam; apagados somem.
 */
export async function topItems(
  tx: TenantTx,
  { tenantId, categoryId, days = 30, limit = 10, now = new Date() }: { tenantId: string; categoryId?: string; days?: number; limit?: number; now?: Date },
): Promise<TopItem[]> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await tx.$queryRaw<{ item_id: string; name: string; category_id: string; quantity: bigint; revenue_cents: bigint }[]>`
    SELECT i.id AS item_id, i.name, i.category_id,
           SUM(oi.quantity) AS quantity,
           ROUND(SUM(oi.unit_price * oi.quantity) * 100) AS revenue_cents
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id AND oi.tenant_id = o.tenant_id
    JOIN menu_items i ON i.id = oi.menu_item_id AND i.tenant_id = o.tenant_id
    WHERE o.tenant_id = ${tenantId}::uuid
      AND o.status <> 'CANCELED'
      AND o.placed_at >= ${since}::timestamptz AND o.placed_at <= ${now}::timestamptz
      AND (${categoryId ?? null}::uuid IS NULL OR i.category_id = ${categoryId ?? null}::uuid)
    GROUP BY i.id, i.name, i.category_id
    ORDER BY quantity DESC, revenue_cents DESC, i.name ASC
    LIMIT ${limit}`;
  return rows.map((row) => ({
    itemId: row.item_id,
    name: row.name,
    categoryId: row.category_id,
    quantity: Number(row.quantity),
    revenueCents: Number(row.revenue_cents),
  }));
}
