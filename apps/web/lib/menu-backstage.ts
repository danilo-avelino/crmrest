// Abas novas do Cardápio (cardapio-backstage.html, 26/11/2026): tipos das respostas da API e regras de tela sem React.

import { money } from "@/lib/menu";

export type ChoiceKind = "HALF" | "SIZE" | "DRINK" | "EXTRA";
export const KIND_LABEL: Record<ChoiceKind, string> = { HALF: "Meias", SIZE: "Tamanhos", DRINK: "Bebidas", EXTRA: "Extras" };
export const KIND_ORDER: ChoiceKind[] = ["HALF", "SIZE", "DRINK", "EXTRA"];

export type Choice = {
  id: string;
  name: string;
  kind: ChoiceKind;
  code: string | null;
  costCents: number | null;
  description: string | null;
  photoUrl: string | null;
  active: boolean;
  inStock: boolean;
  options: { id: string; priceCents: number; group: { id: string; name: string } }[];
};

/** "Esta opção custa R$ 8,00 em "Borda da pizza G" e R$ 6,00 em "Borda da pizza M"." */
export function choicePricesText(choice: Pick<Choice, "options">): string | null {
  if (!choice.options.length) return null;
  const parts = choice.options.map((o) => `${money(o.priceCents)} em "${o.group.name}"`);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} e ${parts.at(-1)}`;
  return `Esta opção custa ${list}.`;
}

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ---------- Cupons ----------

export type CouponKind = "FIXED" | "PERCENT" | "FREE_DELIVERY";
export type CouponStatus =
  | { kind: "AVAILABLE"; until: string | null }
  | { kind: "OUT_OF_HOURS"; nextAt: string | null }
  | { kind: "EXPIRED"; reason: "DATE" | "LIMIT"; since: string | null }
  | { kind: "INACTIVE" };

export type Coupon = {
  id: string;
  name: string;
  code: string | null;
  kind: CouponKind;
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
  paymentMethods: ("pix" | "card" | "cash")[];
  categoryIds: string[];
  itemIds: string[];
  active: boolean;
  createdAt: string;
  uses: number;
  discountedCents: number;
  status: CouponStatus;
  scheduleText: string;
};

export const WEEKDAY_SHORT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
/** Segunda primeiro, como o design. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const timeFmt = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Sao_Paulo" });
const weekdayFmt = new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone: "America/Sao_Paulo" });
const dayFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });

/** "20h" ou "20h30" de um instante, em Brasília. */
export function hourText(iso: string): string {
  const [h, m] = timeFmt.format(new Date(iso)).split(":");
  return m === "00" ? `${Number(h)}h` : `${Number(h)}h${m}`;
}

/** Minutos do dia em "18h" / "18h30". */
export const minuteText = (minute: number) => (minute % 60 ? `${Math.floor(minute / 60)}h${String(minute % 60).padStart(2, "0")}` : `${Math.floor(minute / 60)}h`);

/** "amanhã, 11h", "ter, 18h" ou "hoje, 18h" (a próxima vez que um cupom ou aviso volta). */
export function whenText(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const day = (d: Date) => dayFmt.format(d);
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const label = day(at) === day(now) ? "hoje" : day(at) === day(tomorrow) ? "amanhã" : weekdayFmt.format(at).replace(".", "");
  return `${label}, ${hourText(iso)}`;
}

/** "10/07" de um AAAA-MM-DD. */
export const shortDate = (isoDay: string) => `${isoDay.slice(8, 10)}/${isoDay.slice(5, 7)}`;
/** "31/12/2026" de um AAAA-MM-DD. */
export const longDate = (isoDay: string) => `${isoDay.slice(8, 10)}/${isoDay.slice(5, 7)}/${isoDay.slice(0, 4)}`;

/** "10% · máx. R$ 20", "R$ 15,00", "Entrega grátis", "20% · pedido mín. R$ 60". */
export function discountText(c: Pick<Coupon, "kind" | "valueCents" | "percent" | "maxDiscountCents" | "minOrderCents">): string {
  const main = c.kind === "FREE_DELIVERY" ? "Entrega grátis" : c.kind === "FIXED" ? money(c.valueCents) : `${c.percent}%`;
  const extras = [c.kind === "PERCENT" && c.maxDiscountCents != null ? `máx. ${money(c.maxDiscountCents).replace(",00", "")}` : null, c.minOrderCents > 0 ? `pedido mín. ${money(c.minOrderCents).replace(",00", "")}` : null].filter(Boolean);
  return [main, ...extras].join(" · ");
}

/** "01/11 a 31/12 · seg a qui, 18h–20h", "até 30/11", "Sem data para acabar". */
export function validityText(c: Pick<Coupon, "startsOn" | "endsOn" | "weekdays" | "startMinute" | "endMinute">): string {
  const dates = c.startsOn && c.endsOn ? `${shortDate(c.startsOn)} a ${shortDate(c.endsOn)}` : c.endsOn ? `até ${shortDate(c.endsOn)}` : c.startsOn ? `a partir de ${shortDate(c.startsOn)}` : null;
  const days = [...c.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const contiguous = days.length > 2 && days.every((d, i) => i === 0 || (d === days[i - 1]! + 1) || (days[i - 1] === 6 && d === 0));
  const dayText = !days.length || days.length === 7 ? null : contiguous ? `${WEEKDAY_SHORT[days[0]!]!.toLowerCase()} a ${WEEKDAY_SHORT[days.at(-1)!]!.toLowerCase()}` : days.map((d) => WEEKDAY_SHORT[d]!.toLowerCase()).join(", ");
  const hours = c.startMinute != null && c.endMinute != null ? `${minuteText(c.startMinute)}–${minuteText(c.endMinute)}` : null;
  const when = [dayText, hours].filter(Boolean).join(", ");
  if (!dates && !when) return "Sem data para acabar";
  return [dates, when].filter(Boolean).join(" · ");
}

/** Situação na lista, com o texto de apoio embaixo ("até 20h", "volta amanhã, 11h", "terminou em 10/07"). */
export function couponStatusView(status: CouponStatus, now = new Date()): { label: string; tone: "success" | "warning" | "muted"; sub: string | null } {
  switch (status.kind) {
    case "AVAILABLE":
      return { label: "Disponível", tone: "success", sub: status.until ? `até ${hourText(status.until)}` : null };
    case "OUT_OF_HOURS":
      return { label: "Fora do horário", tone: "warning", sub: status.nextAt ? `volta ${whenText(status.nextAt, now)}` : null };
    case "EXPIRED":
      return { label: "Expirado", tone: "muted", sub: status.reason === "LIMIT" ? "usos esgotados" : status.since ? `terminou em ${shortDate(status.since)}` : null };
    default:
      return { label: "Inativo", tone: "muted", sub: null };
  }
}

// ---------- Avisos ----------

export type NoticeStatus = { kind: "LIVE"; until: string | null } | { kind: "OUT_OF_HOURS"; nextAt: string | null } | { kind: "ENDED"; since: string } | { kind: "PAUSED" };
export type Notice = {
  id: string;
  title: string;
  body: string | null;
  photoUrl: string | null;
  weekdays: number[];
  startMinute: number | null;
  endMinute: number | null;
  endsOn: string | null;
  active: boolean;
  pausedBy: string | null;
  status: NoticeStatus;
};

// ---------- Relatório ----------

export type ReportRow = { id: string; name: string; quantity: number; revenueCents: number; costCents: number | null; averageCents: number; marginPct: number | null };
export type SalesReport = {
  from: string;
  to: string;
  until: string;
  grouping: "hour" | "day";
  totals: { productsCents: number; feesCents: number; discountsCents: number; revenueCents: number; orders: number; averageCents: number };
  previous: { revenueCents: number; orders: number; until: string };
  series: { current: number[]; previous: number[] };
  categories: ReportRow[];
  items: ReportRow[];
  options: ReportRow[];
};

/** Variação em % contra o período anterior; null sem base. */
export function changePct(now: number, before: number): number | null {
  if (before <= 0) return null;
  return Math.round(((now - before) / before) * 1000) / 10;
}

/** CSV com ponto e vírgula (o Excel em português abre direto) e vírgula decimal. */
export function reportCsv(rows: ReportRow[], label: string): string {
  const reais = (cents: number | null) => (cents == null ? "" : (cents / 100).toFixed(2).replace(".", ","));
  const quote = (text: string) => `"${text.replace(/"/g, '""')}"`;
  const header = [label, "Quantidade", "Faturamento", "Preço médio", "Custo total", "Margem (%)"].join(";");
  return [header, ...rows.map((r) => [quote(r.name), r.quantity, reais(r.revenueCents), reais(r.averageCents), reais(r.costCents), r.marginPct ?? ""].join(";"))].join("\n");
}
