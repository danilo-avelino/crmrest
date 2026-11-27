import type { TenantTx } from "@dishdesk/database";

/**
 * Cupons do cardápio (board N4, 26/11/2026): por código ou automáticos (sem código), com dia, horário e regras. As
 * contas de status e de desconto são puras; `loadCoupon*` e `couponUsage` leem o banco. Horário de Brasília (UTC−3
 * fixo, o mesmo de delivery.ts). Dinheiro em centavos inteiros.
 */

const OFFSET_MS = -180 * 60_000;

export type CouponRule = {
  id: string;
  name: string;
  code: string | null;
  kind: "FIXED" | "PERCENT" | "FREE_DELIVERY";
  valueCents: number;
  percent: number;
  maxDiscountCents: number | null;
  startsOn: string | null;
  endsOn: string | null;
  weekdays: number[];
  startMinute: number | null;
  endMinute: number | null;
  delivery: boolean;
  pickup: boolean;
  usageLimit: number | null;
  minOrderCents: number;
  newCustomersOnly: boolean;
  oncePerCustomer: boolean;
  paymentMethods: string[];
  categoryIds: string[];
  itemIds: string[];
  active: boolean;
};

export type CouponStatus =
  | { kind: "AVAILABLE"; until: string | null }
  | { kind: "OUT_OF_HOURS"; nextAt: string | null }
  | { kind: "EXPIRED"; reason: "DATE" | "LIMIT"; since: string | null }
  | { kind: "INACTIVE" };

/** Dia (AAAA-MM-DD), dia da semana e minuto do dia em Brasília. */
export function brtClock(at: Date): { day: string; weekday: number; minute: number } {
  const local = new Date(at.getTime() + OFFSET_MS);
  return { day: local.toISOString().slice(0, 10), weekday: local.getUTCDay(), minute: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

const hasHours = (c: Pick<CouponRule, "startMinute" | "endMinute">) => c.startMinute != null && c.endMinute != null && c.startMinute !== c.endMinute;

/** Vale neste instante pelo calendário (datas, dias e faixa de horário)? Fim exclusivo; fim antes do início vira o dia. */
export function inSchedule(c: Pick<CouponRule, "startsOn" | "endsOn" | "weekdays" | "startMinute" | "endMinute">, at: Date): boolean {
  const { day, weekday, minute } = brtClock(at);
  if (c.startsOn && day < c.startsOn) return false;
  if (c.endsOn && day > c.endsOn) return false;
  const dayOk = (d: number) => !c.weekdays.length || c.weekdays.includes(d);
  if (!hasHours(c)) return dayOk(weekday);
  const start = c.startMinute!;
  const end = c.endMinute!;
  if (end > start) return dayOk(weekday) && minute >= start && minute < end;
  return (dayOk(weekday) && minute >= start) || (dayOk((weekday + 6) % 7) && minute < end);
}

/** Próximo instante (até 8 dias) em que o calendário volta a valer; null se não volta. Passo de 15 min. */
export type Schedule = Pick<CouponRule, "startsOn" | "endsOn" | "weekdays" | "startMinute" | "endMinute">;

export function nextScheduleStart(c: Schedule, now: Date): Date | null {
  const step = 15 * 60_000;
  const first = Math.ceil(now.getTime() / step) * step;
  for (let t = first; t < now.getTime() + 8 * 86_400_000; t += step) if (inSchedule(c, new Date(t))) return new Date(t);
  return null;
}

/** Fim da janela que está valendo agora (para "até 20h"); null sem faixa de horário. */
export function currentWindowEnd(c: Schedule, now: Date): Date | null {
  if (!hasHours(c)) return null;
  const step = 15 * 60_000;
  for (let t = Math.ceil(now.getTime() / step) * step; t < now.getTime() + 86_400_000; t += step) if (!inSchedule(c, new Date(t))) return new Date(t);
  return null;
}

/** Situação na lista (Disponível, Fora do horário, Expirado, Inativo). `uses`: usos já feitos. */
export function couponStatus(c: CouponRule, uses: number, now: Date): CouponStatus {
  if (!c.active) return { kind: "INACTIVE" };
  const { day } = brtClock(now);
  if (c.endsOn && day > c.endsOn) return { kind: "EXPIRED", reason: "DATE", since: c.endsOn };
  if (c.usageLimit != null && uses >= c.usageLimit) return { kind: "EXPIRED", reason: "LIMIT", since: null };
  if (!inSchedule(c, now)) return { kind: "OUT_OF_HOURS", nextAt: nextScheduleStart(c, now)?.toISOString() ?? null };
  return { kind: "AVAILABLE", until: currentWindowEnd(c, now)?.toISOString() ?? null };
}

export type CouponLine = { itemId: string; categoryId: string; totalCents: number };

/** Parte do carrinho onde o desconto vale: as categorias e os itens escolhidos (nenhum = o carrinho todo). */
export function eligibleCents(c: Pick<CouponRule, "categoryIds" | "itemIds">, lines: CouponLine[]): number {
  const scoped = c.categoryIds.length > 0 || c.itemIds.length > 0;
  return lines.reduce((sum, l) => (!scoped || c.categoryIds.includes(l.categoryId) || c.itemIds.includes(l.itemId) ? sum + l.totalCents : sum), 0);
}

/** Desconto em reais (até a parte elegível) e se zera a entrega. */
export function couponDiscount(c: CouponRule, lines: CouponLine[]): { discountCents: number; freeDelivery: boolean } {
  const base = eligibleCents(c, lines);
  if (c.kind === "FREE_DELIVERY") return { discountCents: 0, freeDelivery: true };
  if (c.kind === "FIXED") return { discountCents: Math.min(c.valueCents, base), freeDelivery: false };
  const raw = Math.round((base * c.percent) / 100);
  return { discountCents: c.maxDiscountCents != null ? Math.min(raw, c.maxDiscountCents) : raw, freeDelivery: false };
}

export type CouponContext = {
  now: Date;
  lines: CouponLine[];
  subtotalCents: number;
  mode: "DELIVERY" | "PICKUP" | null;
  paymentMethod: string | null;
  verified: boolean;
  uses: number;
  /** Já usou este cupom (só conta com o cliente provado pelo código). */
  usedByContact: boolean;
  /** Tem pedido não cancelado antes. */
  returningCustomer: boolean;
};

/** Motivo para recusar (em português, para o cliente) ou null quando o cupom vale para este pedido. */
export function couponRefusal(c: CouponRule, ctx: CouponContext): string | null {
  const status = couponStatus(c, ctx.uses, ctx.now);
  if (status.kind === "INACTIVE" || status.kind === "EXPIRED") return "Este cupom não está mais valendo.";
  if (status.kind === "OUT_OF_HOURS") return `Este cupom vale ${scheduleText(c)}.`;
  if (ctx.mode === "DELIVERY" && !c.delivery) return "Este cupom vale só para retirada.";
  if (ctx.mode === "PICKUP" && !c.pickup) return "Este cupom vale só para entrega.";
  if ((c.newCustomersOnly || c.oncePerCustomer) && !ctx.verified) return "Entre com o código do WhatsApp para usar este cupom.";
  if (c.newCustomersOnly && ctx.returningCustomer) return "Este cupom é só para o primeiro pedido.";
  if (c.oncePerCustomer && ctx.usedByContact) return "Você já usou este cupom.";
  if (ctx.subtotalCents < c.minOrderCents) return `Este cupom vale a partir de ${brl(c.minOrderCents)}.`;
  if (ctx.paymentMethod && c.paymentMethods.length && !c.paymentMethods.includes(ctx.paymentMethod)) return "Este cupom não vale para essa forma de pagamento.";
  if (c.kind !== "FREE_DELIVERY" && eligibleCents(c, ctx.lines) === 0) return "Nenhum item da sacola entra neste cupom.";
  if (c.kind === "FREE_DELIVERY" && ctx.mode === "PICKUP") return "Este cupom é de entrega grátis.";
  return null;
}

const DAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const hour = (m: number) => (m % 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${Math.floor(m / 60)}h`);
const brl = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;

/** "de seg a qui, das 18h às 20h" (o que o cliente vê fora do horário). */
export function scheduleText(c: Pick<CouponRule, "weekdays" | "startMinute" | "endMinute">): string {
  const days = [...c.weekdays].sort((a, b) => a - b);
  const contiguous = days.length > 2 && days.every((d, i) => i === 0 || d === days[i - 1]! + 1);
  const dayText = !days.length || days.length === 7 ? "todos os dias" : contiguous ? `de ${DAY_SHORT[days[0]!]} a ${DAY_SHORT[days.at(-1)!]}` : days.map((d) => DAY_SHORT[d]).join(", ");
  return hasHours(c) ? `${dayText}, das ${hour(c.startMinute!)} às ${hour(c.endMinute!)}` : dayText;
}

const RULE_SELECT = {
  id: true,
  name: true,
  code: true,
  kind: true,
  valueCents: true,
  percent: true,
  maxDiscountCents: true,
  startsOn: true,
  endsOn: true,
  weekdays: true,
  startMinute: true,
  endMinute: true,
  delivery: true,
  pickup: true,
  usageLimit: true,
  minOrderCents: true,
  newCustomersOnly: true,
  oncePerCustomer: true,
  paymentMethods: true,
  categoryIds: true,
  itemIds: true,
  active: true,
} as const;

/** Usos por cupom (contagem e valor descontado). */
export async function couponUsage(tx: TenantTx, tenantId: string, couponIds: string[]): Promise<Map<string, { uses: number; discountCents: number }>> {
  if (!couponIds.length) return new Map();
  const rows = await tx.menuCouponRedemption.groupBy({ by: ["couponId"], where: { tenantId, couponId: { in: couponIds } }, _count: { _all: true }, _sum: { discountCents: true } });
  return new Map(rows.map((r) => [r.couponId, { uses: r._count._all, discountCents: r._sum.discountCents ?? 0 }]));
}

export type CandidateCoupon = CouponRule & { refusal: string | null; discountCents: number; freeDelivery: boolean };

/**
 * Cupons que podem entrar neste pedido: o do código digitado (se houver) e os automáticos (sem código) ligados. Cada
 * um volta com o motivo da recusa ou o desconto. O código é comparado em maiúsculas e sem espaços.
 */
export async function candidateCoupons(
  tx: TenantTx,
  input: { tenantId: string; contactId: string | null; code: string | null; ctx: Omit<CouponContext, "uses" | "usedByContact" | "returningCustomer"> },
): Promise<{ typed: CandidateCoupon | null; typedMissing: boolean; automatic: CandidateCoupon[] }> {
  const code = input.code?.trim().toUpperCase() || null;
  const rows = await tx.menuCoupon.findMany({
    where: { tenantId: input.tenantId, active: true, OR: [{ code: null }, ...(code ? [{ code }] : [])] },
    select: RULE_SELECT,
  });
  const usage = await couponUsage(tx, input.tenantId, rows.map((r) => r.id));
  const returningCustomer = input.contactId
    ? Boolean(await tx.order.findFirst({ where: { tenantId: input.tenantId, contactId: input.contactId, status: { not: "CANCELED" } }, select: { id: true } }))
    : false;
  const used = input.contactId
    ? new Set((await tx.menuCouponRedemption.findMany({ where: { tenantId: input.tenantId, contactId: input.contactId, couponId: { in: rows.map((r) => r.id) } }, select: { couponId: true } })).map((r) => r.couponId))
    : new Set<string>();
  const evaluate = (rule: CouponRule): CandidateCoupon => {
    const refusal = couponRefusal(rule, { ...input.ctx, uses: usage.get(rule.id)?.uses ?? 0, usedByContact: used.has(rule.id), returningCustomer });
    return { ...rule, refusal, ...(refusal ? { discountCents: 0, freeDelivery: false } : couponDiscount(rule, input.ctx.lines)) };
  };
  const typedRow = code ? rows.find((r) => r.code === code) : undefined;
  return {
    typed: typedRow ? evaluate(typedRow) : null,
    typedMissing: Boolean(code) && !typedRow,
    automatic: rows.filter((r) => r.code == null).map(evaluate),
  };
}
