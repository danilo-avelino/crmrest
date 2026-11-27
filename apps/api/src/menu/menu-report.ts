import type { TenantTx } from "@dishdesk/database";
import { BadRequestException, Controller, Get, Injectable, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { MenuService } from "./menu.service.js";

/** Brasília não tem horário de verão desde 2019: UTC−3 fixo (o mesmo de delivery.ts). */
const OFFSET_MS = -180 * 60_000;
const DAY_MS = 86_400_000;
const MAX_DAYS = 92;

/** Meia-noite de Brasília de um dia AAAA-MM-DD, em UTC. */
function midnightOf(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!) - OFFSET_MS);
}

/** O dia de Brasília (AAAA-MM-DD) de um instante. */
export function brtDay(at: Date): string {
  return new Date(at.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

export type ReportWindow = { start: Date; end: Date; days: number; previous: { start: Date; end: Date } };

/**
 * Janela do relatório: do começo de `from` ao fim de `to` (dias de Brasília), cortada em `now` quando `to` é hoje. A
 * comparação é a mesma janela deslocada para trás pelo número de dias: "hoje até as 21h" contra "ontem até as 21h".
 */
export function reportWindow(from: string, to: string, now: Date): ReportWindow {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new BadRequestException("Datas no formato AAAA-MM-DD.");
  const start = midnightOf(from);
  const dayAfter = new Date(midnightOf(to).getTime() + DAY_MS);
  if (dayAfter <= start) throw new BadRequestException("A data final vem antes da inicial.");
  const days = Math.round((dayAfter.getTime() - start.getTime()) / DAY_MS);
  if (days > MAX_DAYS) throw new BadRequestException(`O período vai até ${MAX_DAYS} dias.`);
  const end = dayAfter > now ? now : dayAfter;
  const shift = days * DAY_MS;
  return { start, end, days, previous: { start: new Date(start.getTime() - shift), end: new Date(end.getTime() - shift) } };
}

type Row = { name: string; quantity: number; revenueCents: number; costCents: number | null };
export type ReportRow = Row & { id: string; averageCents: number; marginPct: number | null };

type OrderRow = { id: string; placedAt: Date; subtotal: unknown; deliveryFee: unknown; total: unknown; raw: unknown };
const cents = (value: unknown) => Math.round(Number(value) * 100);

/** Somas do período: produtos + taxas − descontos = faturamento. */
function totalsOf(orders: OrderRow[]) {
  let productsCents = 0;
  let feesCents = 0;
  let revenueCents = 0;
  for (const o of orders) {
    productsCents += cents(o.subtotal);
    feesCents += cents(o.deliveryFee);
    revenueCents += cents(o.total);
  }
  const discountsCents = Math.max(0, productsCents + feesCents - revenueCents);
  return { productsCents, feesCents, discountsCents, revenueCents, orders: orders.length, averageCents: orders.length ? Math.round(revenueCents / orders.length) : 0 };
}

/** Faturamento por hora (um dia) ou por dia (mais de um), do começo da janela. */
function seriesOf(orders: OrderRow[], start: Date, days: number): number[] {
  const hourly = days === 1;
  const buckets = Array.from({ length: hourly ? 24 : days }, () => 0);
  for (const o of orders) {
    const offset = o.placedAt.getTime() - start.getTime();
    const index = Math.floor(offset / (hourly ? 3_600_000 : DAY_MS));
    if (index >= 0 && index < buckets.length) buckets[index]! += cents(o.total);
  }
  return buckets;
}

function finish(rows: Map<string, Row>): ReportRow[] {
  return [...rows.entries()]
    .map(([id, r]) => ({
      id,
      ...r,
      averageCents: r.quantity ? Math.round(r.revenueCents / r.quantity) : 0,
      marginPct: r.costCents == null || r.revenueCents <= 0 ? null : Math.round(((r.revenueCents - r.costCents) / r.revenueCents) * 100),
    }))
    .sort((a, b) => b.revenueCents - a.revenueCents || b.quantity - a.quantity || a.name.localeCompare(b.name));
}

async function breakdown(tx: TenantTx, tenantId: string, orders: OrderRow[]) {
  const orderIds = orders.map((o) => o.id);
  const lines = orderIds.length
    ? await tx.orderItem.findMany({
        where: { tenantId, orderId: { in: orderIds }, menuItemId: { not: null } },
        select: { quantity: true, unitPrice: true, menuItem: { select: { id: true, name: true, costCents: true, category: { select: { id: true, name: true } } } } },
      })
    : [];
  const items = new Map<string, Row>();
  const categories = new Map<string, Row>();
  const add = (map: Map<string, Row>, id: string, name: string, quantity: number, revenueCents: number, unitCost: number | null) => {
    const row = map.get(id) ?? { name, quantity: 0, revenueCents: 0, costCents: 0 };
    row.quantity += quantity;
    row.revenueCents += revenueCents;
    // Sem custo em qualquer linha, a linha toda fica "sem custo" (não entra na margem média).
    row.costCents = row.costCents == null || unitCost == null ? null : row.costCents + unitCost * quantity;
    map.set(id, row);
  };
  for (const line of lines) {
    const item = line.menuItem!;
    const revenue = cents(line.unitPrice) * line.quantity;
    add(items, item.id, item.name, line.quantity, revenue, item.costCents);
    add(categories, item.category.id, item.category.name, line.quantity, revenue, item.costCents);
  }

  // Opções: as escolhidas em cada linha (raw.lines dos pedidos do cardápio), com o preço e o custo de hoje.
  const picks = new Map<string, number>();
  for (const o of orders) {
    const raw = o.raw as { lines?: { optionIds?: string[]; quantity?: number }[] } | null;
    for (const line of raw?.lines ?? []) for (const id of line.optionIds ?? []) picks.set(id, (picks.get(id) ?? 0) + (line.quantity ?? 1));
  }
  const options = new Map<string, Row>();
  if (picks.size) {
    const found = await tx.menuOption.findMany({
      where: { tenantId, id: { in: [...picks.keys()] } },
      select: { id: true, priceCents: true, choice: { select: { id: true, name: true, costCents: true } } },
    });
    for (const option of found) add(options, option.choice.id, option.choice.name, picks.get(option.id)!, option.priceCents * picks.get(option.id)!, option.choice.costCents);
  }
  return { categories: finish(categories), items: finish(items), options: finish(options) };
}

/**
 * Relatório de vendas (board N3): pedidos do cardápio digital e do WhatsApp com IA (`source = MENU`), sem os
 * cancelados. Margem só com custo cadastrado; item sem custo aparece "sem custo" e fica fora da margem média.
 */
@Injectable()
export class MenuReportService {
  constructor(private readonly menu: MenuService) {}

  report(auth: RequestAuth, tenantId: string, from: string, to: string, now = new Date()) {
    const window = reportWindow(from, to, now);
    return this.menu.read(auth, tenantId, async (tx) => {
      const load = (start: Date, end: Date) =>
        tx.order.findMany({
          where: { tenantId, source: "MENU", status: { not: "CANCELED" }, placedAt: { gte: start, lt: end } },
          select: { id: true, placedAt: true, subtotal: true, deliveryFee: true, total: true, raw: true },
        });
      const [current, previous] = await Promise.all([load(window.start, window.end), load(window.previous.start, window.previous.end)]);
      const totals = totalsOf(current);
      const before = totalsOf(previous);
      return {
        from,
        to,
        until: window.end.toISOString(),
        grouping: window.days === 1 ? ("hour" as const) : ("day" as const),
        totals,
        previous: { revenueCents: before.revenueCents, orders: before.orders, until: window.previous.end.toISOString() },
        series: { current: seriesOf(current, window.start, window.days), previous: seriesOf(previous, window.previous.start, window.days) },
        ...(await breakdown(tx, tenantId, current)),
      };
    });
  }
}

/** `GET /menu/:tenantId/report?from=AAAA-MM-DD&to=AAAA-MM-DD` (dias de Brasília; padrão: hoje). */
@Controller("menu/:tenantId/report")
export class MenuReportController {
  constructor(private readonly reports: MenuReportService) {}

  @Get()
  report(@Param("tenantId", ParseUUIDPipe) tenantId: string, @CurrentAuth() auth: RequestAuth, @Query("from") from?: string, @Query("to") to?: string) {
    const today = brtDay(new Date());
    return this.reports.report(auth, tenantId, from ?? today, to ?? from ?? today);
  }
}

/** Pedidos de cada área desenhada (N6) nos últimos 30 dias, pelo `raw.deliveryAreaId` que o pedido grava. */
@Injectable()
export class MenuAreaStatsService {
  constructor(private readonly menu: MenuService) {}

  stats(auth: RequestAuth, tenantId: string, now = new Date()) {
    const since = new Date(now.getTime() - 30 * DAY_MS);
    return this.menu.read(auth, tenantId, async (tx) => {
      const rows = await tx.$queryRaw<{ area_id: string; orders: bigint }[]>`
        SELECT raw->>'deliveryAreaId' AS area_id, COUNT(*) AS orders
        FROM orders
        WHERE tenant_id = ${tenantId}::uuid AND source = 'MENU' AND status <> 'CANCELED'
          AND placed_at >= ${since}::timestamptz AND raw ? 'deliveryAreaId'
        GROUP BY 1`;
      return Object.fromEntries(rows.map((r) => [r.area_id, Number(r.orders)]));
    });
  }
}

@Controller("menu/:tenantId/delivery-areas/stats")
export class MenuAreaStatsController {
  constructor(private readonly areas: MenuAreaStatsService) {}

  @Get()
  stats(@Param("tenantId", ParseUUIDPipe) tenantId: string, @CurrentAuth() auth: RequestAuth) {
    return this.areas.stats(auth, tenantId);
  }
}
