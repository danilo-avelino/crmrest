import { Prisma } from "@dishdesk/database";
import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DatabaseService } from "../core/database.service.js";
import { requireModule } from "../menu/menu.service.js";
import { memberScope } from "../settings/tenant-admin.js";
import { FunnelService } from "./funnel.service.js";

const Query_ = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    channel: z.enum(["WEB", "WHATSAPP"]).optional(),
  })
  .refine((q) => q.to > q.from && q.to.getTime() - q.from.getTime() <= 400 * 86_400_000, { message: "Período inválido" });

/**
 * Dashboard do funil de vendas do cardápio (F7-06), `/menu/:tenantId/funnel`: etapas com visitantes e conversão, origem,
 * canal e os pedidos do cardápio próprio (source MENU, sem cancelados) no período [from, to). A equipe lê; módulo MENU obrigatório.
 */
@Controller("menu/:tenantId/funnel")
export class FunnelDashboardController {
  constructor(
    private readonly db: DatabaseService,
    private readonly funnel: FunnelService,
  ) {}

  @Get()
  get(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Query(new ZodPipe(Query_)) query: z.output<typeof Query_>, @CurrentAuth() auth: RequestAuth) {
    return this.db.withTenants(memberScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      const range = { from: query.from, to: query.to, channel: query.channel };
      const where = { tenantId, source: "MENU" as const, status: { not: "CANCELED" as const }, placedAt: { gte: query.from, lt: query.to } };
      const span = query.to.getTime() - query.from.getTime();
      const previousFrom = new Date(query.from.getTime() - span);
      const previousWhere = { ...where, placedAt: { gte: previousFrom, lt: query.from } };
      const [summary, bySource, byWeb, byWhatsapp, totals, previousTotals, daily, linked] = await Promise.all([
        this.funnel.summary(tx, tenantId, range),
        this.funnel.bySource(tx, tenantId, range),
        this.funnel.summary(tx, tenantId, { from: query.from, to: query.to, channel: "WEB" }),
        this.funnel.summary(tx, tenantId, { from: query.from, to: query.to, channel: "WHATSAPP" }),
        tx.order.aggregate({ where, _count: { _all: true }, _sum: { total: true } }),
        tx.order.aggregate({ where: previousWhere, _count: { _all: true }, _sum: { total: true } }),
        tx.$queryRaw<{ day: string; orders: bigint }[]>(Prisma.sql`
          SELECT to_char(placed_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS day, count(*) AS orders
          FROM orders
          WHERE tenant_id = ${tenantId}::uuid AND source = 'MENU' AND status <> 'CANCELED'
            AND placed_at >= ${query.from} AND placed_at < ${query.to}
          GROUP BY 1 ORDER BY 1`),
        // Ligação confiável pedido -> origem: só o evento PURCHASE gravado com o orderId do pedido (um por pedido).
        tx.$queryRaw<{ source: string; orders: bigint; revenue: Prisma.Decimal }[]>(Prisma.sql`
          SELECT COALESCE(NULLIF(f.attribution->>'utm_source', ''), NULLIF(f.attribution->>'referrer', ''), 'direto') AS source,
                 count(*) AS orders, sum(o.total) AS revenue
          FROM orders o
          JOIN (SELECT DISTINCT ON (order_id) order_id, attribution FROM funnel_events
                WHERE tenant_id = ${tenantId}::uuid AND stage = 'PURCHASE' AND order_id IS NOT NULL
                ORDER BY order_id, created_at) f ON f.order_id = o.id
          WHERE o.tenant_id = ${tenantId}::uuid AND o.source = 'MENU' AND o.status <> 'CANCELED'
            AND o.placed_at >= ${query.from} AND o.placed_at < ${query.to}
          GROUP BY 1`),
      ]);
      const orders = totals._count._all;
      const revenueCents = Math.round(Number(totals._sum.total ?? 0) * 100);
      const ticketBySource = linked.map((l) => ({ source: l.source, orders: Number(l.orders), revenueCents: Math.round(Number(l.revenue) * 100) }));
      const linkedOrders = ticketBySource.reduce((n, t) => n + t.orders, 0);
      const purchases = (s: typeof summary) => s.steps.find((step) => step.stage === "PURCHASE")?.visitors ?? 0;
      return {
        summary,
        bySource,
        byChannel: { WEB: purchases(byWeb), WHATSAPP: purchases(byWhatsapp) },
        orders,
        revenueCents,
        averageTicketCents: orders > 0 ? Math.round(revenueCents / orders) : 0,
        previous: { orders: previousTotals._count._all, revenueCents: Math.round(Number(previousTotals._sum.total ?? 0) * 100) },
        ticketBySource,
        unattributedOrders: orders - linkedOrders,
        daily: daily.map((d) => ({ day: d.day, orders: Number(d.orders) })),
      };
    });
  }
}
