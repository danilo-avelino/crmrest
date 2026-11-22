"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { ErrorNote, loadError, PageHeader, Skeleton, WarnNote } from "@/components/menu/bits";
import { useTenantId } from "@/components/menu/use-menu";
import { Button } from "@/components/ui/button";
import { count, currency, percent } from "@/lib/format";
import { cn } from "@/lib/utils";

type Stage = "PAGE_VIEW" | "VIEW_CONTENT" | "ADD_TO_CART" | "INITIATE_CHECKOUT" | "ADD_PAYMENT_INFO" | "PURCHASE";
type FunnelDto = {
  summary: { steps: { stage: Stage; events: number; visitors: number }[]; searches: number };
  bySource: { source: string; stage: Stage; visitors: number }[];
  byChannel: { WEB: number; WHATSAPP: number };
  orders: number;
  revenueCents: number;
  averageTicketCents: number;
  daily: { day: string; orders: number }[];
  previous: { orders: number; revenueCents: number };
  ticketBySource: { source: string; orders: number; revenueCents: number }[];
  unattributedOrders: number;
};

const STAGE_LABEL: Record<Stage, string> = {
  PAGE_VIEW: "Visitou",
  VIEW_CONTENT: "Viu item",
  ADD_TO_CART: "Adicionou à sacola",
  INITIATE_CHECKOUT: "Iniciou checkout",
  ADD_PAYMENT_INFO: "Gerou Pix",
  PURCHASE: "Pagou",
};
const PERIODS = [
  { key: "today", label: "Hoje", days: 1 },
  { key: "7d", label: "7 dias", days: 7 },
  { key: "30d", label: "30 dias", days: 30 },
  { key: "month", label: "Mês", days: 0 }, // do dia 1 até hoje
] as const;
type PeriodKey = (typeof PERIODS)[number]["key"];

const DAY_MS = 86_400_000;
const BRT_OFFSET_MS = 3 * 3_600_000;
const CARD = "rounded-xl border border-rule bg-surface p-5";
const TITLE = "font-heading text-title font-semibold";

/** O dia (meia-noite de Brasília) que começa em `ms`, como "AAAA-MM-DD". */
const brtDay = (ms: number) => new Date(ms - BRT_OFFSET_MS).toISOString().slice(0, 10);

/** Intervalo [from, to) do período: os últimos `days` dias de Brasília, incluindo hoje (days 0: o mês corrente até hoje). */
export function rangeOf(days: number, now: number) {
  const startOfTomorrow = (Math.floor((now - BRT_OFFSET_MS) / DAY_MS) + 1) * DAY_MS + BRT_OFFSET_MS;
  const today = new Date(startOfTomorrow - BRT_OFFSET_MS - 1);
  const length = days > 0 ? days : today.getUTCDate();
  const startMs = startOfTomorrow - length * DAY_MS;
  return { from: new Date(startMs).toISOString(), to: new Date(startOfTomorrow).toISOString(), days: length, startMs };
}

/** Variação do faturamento contra o período anterior de mesma duração: "+18% que o período anterior". */
export function comparison(revenueCents: number, previousCents: number): { text: string; up: boolean } | null {
  if (previousCents <= 0) return null;
  const change = Math.round((revenueCents / previousCents - 1) * 100);
  return { text: `${change > 0 ? "+" : ""}${change}% que o período anterior`, up: change >= 0 };
}

const sourceLabel = (source: string) => (source === "direto" ? "Link direto" : source.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40));

/** P6: funil de vendas do cardápio: pedidos e faturamento do período, onde o cliente parou, canal, origem e ticket médio. */
export function FunnelDashboard() {
  const { request, session } = useAuth();
  const tenantId = useTenantId();
  const [period, setPeriod] = useState<PeriodKey>("7d");
  const [now] = useState(() => Date.now());
  const range = rangeOf(PERIODS.find((p) => p.key === period)!.days, now);
  const funnel = useQuery({
    queryKey: ["menu-funnel", tenantId, period, brtDay(now)],
    queryFn: () => request<FunnelDto>(`/menu/${tenantId}/funnel?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`),
    enabled: Boolean(tenantId),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data = funnel.data;
  const slug = session?.tenants.find((tenant) => tenant.id === tenantId)?.slug;

  const visits = data?.summary.steps[0]?.visitors ?? 0;
  const empty = data !== undefined && visits === 0 && data.orders === 0;

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-5 pb-10">
      <PageHeader crumb="Cardápio / Funil de vendas" title="Funil de vendas" />
      {funnel.isError && (
        <ErrorNote
          action={
            <Button size="sm" variant="outline" onClick={() => funnel.refetch()}>
              Tentar de novo
            </Button>
          }
        >
          {loadError(funnel.error).forbidden ? loadError(funnel.error).text : "Não conseguimos carregar o funil agora."}
        </ErrorNote>
      )}
      {!data && !funnel.isError && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-[210px]" />
          <Skeleton className="h-[300px]" />
        </div>
      )}
      {empty && (
        <section className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-[#C4B8A0] bg-surface px-5 py-8 text-center">
          <div className="font-heading text-lg font-semibold">Ainda não há visitas no cardápio</div>
          <div className="text-ink-2">Divulgue o link na bio do Instagram e no WhatsApp para ver o funil aqui.</div>
          {slug && <Button onClick={() => navigator.clipboard.writeText(`${window.location.origin}/c/${slug}`)}>Copiar o link do cardápio</Button>}
        </section>
      )}
      {data && !empty && (
        <div className={cn("flex flex-col gap-4", funnel.isPlaceholderData && "opacity-60")} aria-busy={funnel.isPlaceholderData}>
          <Headline data={data} period={period} onPeriod={setPeriod} range={range} />
          <div className="flex flex-wrap items-start gap-4">
            <Steps data={data} />
            <Breakdown data={data} />
          </div>
        </div>
      )}
    </main>
  );
}

function Headline({ data, period, onPeriod, range }: { data: FunnelDto; period: PeriodKey; onPeriod: (p: PeriodKey) => void; range: ReturnType<typeof rangeOf> }) {
  const versus = comparison(data.revenueCents, data.previous.revenueCents);
  return (
    <section className={cn(CARD, "flex flex-col gap-3")}>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-[300px] flex-1">
          <div className="text-ink-3">Pedidos do cardápio</div>
          <div className="flex items-baseline gap-2.5">
            <span className="font-heading text-[40px] leading-[1.1] font-bold tabular-nums">{count(data.orders)}</span>
            <span className="text-title font-semibold tabular-nums">{currency(data.revenueCents / 100)}</span>
            {versus ? (
              <span className={cn("font-medium", versus.up ? "text-success-ink" : "text-tomate")}>{versus.text}</span>
            ) : (
              <span className="text-ink-3">sem pedidos no período anterior para comparar</span>
            )}
          </div>
        </div>
        <div role="tablist" aria-label="Período" className="flex rounded-xl bg-rule-soft p-[3px]">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              role="tab"
              aria-selected={p.key === period}
              onClick={() => onPeriod(p.key)}
              className={cn("h-[30px] rounded-lg px-3 text-[13px]", p.key === period ? "bg-surface font-semibold" : "font-normal text-ink-2")}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <DailyChart daily={data.daily} range={range} />
    </section>
  );
}

/** Pedidos por dia. Um período de um dia só vira o número; a linha precisa de pelo menos dois dias. */
function DailyChart({ daily, range }: { daily: FunnelDto["daily"]; range: ReturnType<typeof rangeOf> }) {
  if (range.days < 2) return null;
  const byDay = new Map(daily.map((d) => [d.day, d.orders]));
  const points = Array.from({ length: range.days }, (_, i) => {
    const day = brtDay(range.startMs + (i + 1) * DAY_MS - 1);
    return { day, orders: byDay.get(day) ?? 0, label: `${day.slice(8, 10)}/${day.slice(5, 7)}` };
  });
  const max = Math.max(4, ...points.map((p) => p.orders));
  const W = 700;
  const left = 30;
  const x = (i: number) => left + ((W - left) * (i + 0.5)) / points.length;
  const y = (v: number) => 100 - (v / max) * 90;
  const peak = points.reduce((a, b) => (b.orders > a.orders ? b : a));
  const step = Math.ceil(points.length / 8);
  return (
    <svg viewBox="0 0 700 120" width="100%" height="120" role="img" aria-label={`Pedidos por dia: no máximo ${peak.orders}, em ${peak.label}`}>
      <g className="stroke-rule-soft" strokeWidth="1">
        {[0, max / 2, max].map((v) => (
          <line key={v} x1={left} x2={W} y1={y(v)} y2={y(v)} />
        ))}
      </g>
      <g className="fill-ink-3 text-[11px]">
        {[0, max / 2, max].map((v) => (
          <text key={v} x="0" y={y(v) + 4}>
            {Math.round(v)}
          </text>
        ))}
      </g>
      <polyline fill="none" className="stroke-ink" strokeWidth="2" points={points.map((p, i) => `${x(i)},${y(p.orders)}`).join(" ")} />
      <g className="fill-ink">
        {points.map((p, i) => (
          <circle key={p.day} cx={x(i)} cy={y(p.orders)} r={p === peak ? 4 : 3}>
            <title>{`${p.label}: ${p.orders} ${p.orders === 1 ? "pedido" : "pedidos"}`}</title>
          </circle>
        ))}
      </g>
      {peak.orders > 0 && (
        <text x={x(points.indexOf(peak))} y={y(peak.orders) - 8} textAnchor="middle" className="fill-ink text-[11px] font-semibold">
          {peak.orders}
        </text>
      )}
      <g className="fill-ink-3 text-[11px]" textAnchor="middle">
        {points.map((p, i) =>
          i % step === 0 ? (
            <text key={p.day} x={x(i)} y="118">
              {p.label}
            </text>
          ) : null,
        )}
      </g>
    </svg>
  );
}

function Steps({ data }: { data: FunnelDto }) {
  const steps = data.summary.steps;
  const first = steps[0]?.visitors ?? 0;
  const drops = steps.slice(0, -1).map((s, i) => {
    const next = steps[i + 1]?.visitors ?? 0;
    return { lost: s.visitors - next, share: s.visitors > 0 ? 1 - next / s.visitors : 0 };
  });
  let worstIndex = -1;
  drops.forEach((d, i) => {
    if (d.lost > 0 && (worstIndex < 0 || d.share > drops[worstIndex]!.share)) worstIndex = i;
  });
  const pix = steps.find((s) => s.stage === "ADD_PAYMENT_INFO")?.visitors ?? 0;
  const paid = steps.find((s) => s.stage === "PURCHASE")?.visitors ?? 0;
  const unpaid = Math.max(0, pix - paid);
  return (
    <section className={cn(CARD, "flex flex-[3_1_520px] flex-col gap-1.5")}>
      <h2 className={cn(TITLE, "mb-1.5")}>Onde o cliente parou</h2>
      {steps.map((s, i) => {
        const next = steps[i + 1];
        return (
          <div key={s.stage} className="flex flex-col gap-1.5">
            <div className="grid min-h-[34px] grid-cols-[150px_1fr_64px] items-center gap-3">
              <span className="font-medium">{STAGE_LABEL[s.stage]}</span>
              <div className="h-[22px] overflow-hidden rounded-sm bg-surface-2">
                <div className={cn("h-full", s.stage === "PURCHASE" ? "bg-success" : "bg-ink")} style={{ width: `${first > 0 ? Math.round((s.visitors / first) * 100) : 0}%` }} />
              </div>
              <span className="text-right font-semibold tabular-nums">{count(s.visitors)}</span>
            </div>
            {next && (
              <div className={cn("grid grid-cols-[150px_1fr] gap-3 text-xs", i === worstIndex ? "text-tomate" : "text-ink-3")}>
                <span />
                <span>
                  ↓ {percent(drops[i]!.share)} pararam aqui · {percent(first > 0 ? next.visitors / first : 0)} das visitas seguem
                </span>
              </div>
            )}
          </div>
        );
      })}
      {worstIndex >= 0 && (
        <div className="mt-2">
          <WarnNote
            action={
              unpaid > 0 ? (
                <Link href="/cardapio/abandonados" className="inline-flex h-[30px] items-center rounded-lg border border-rule bg-surface px-3 font-medium text-ink no-underline">
                  Ver abandonados
                </Link>
              ) : undefined
            }
          >
            A maior queda é de {STAGE_LABEL[steps[worstIndex]!.stage].toLowerCase()} para {STAGE_LABEL[steps[worstIndex + 1]!.stage].toLowerCase()}: {percent(drops[worstIndex]!.share)} saem aqui.
            {unpaid > 0 && ` ${count(unpaid)} ${unpaid === 1 ? "Pix foi gerado e não pago" : "Pix foram gerados e não pagos"}.`}
          </WarnNote>
        </div>
      )}
    </section>
  );
}

/** Ticket médio da origem só com os pedidos ligados a ela pelo evento de compra; sem ligação, "—" (nunca um número inventado). */
const ticketOf = (t: { orders: number; revenueCents: number } | undefined) => (t && t.orders > 0 ? currency(t.revenueCents / t.orders / 100) : "—");

function Breakdown({ data }: { data: FunnelDto }) {
  const channelTotal = data.byChannel.WEB + data.byChannel.WHATSAPP;
  const channels = [
    { label: "Site (cardápio)", n: data.byChannel.WEB },
    { label: "WhatsApp pela IA", n: data.byChannel.WHATSAPP },
  ];
  const sources = new Map<string, { visits: number; orders: number }>();
  for (const row of data.bySource) {
    const entry = sources.get(row.source) ?? { visits: 0, orders: 0 };
    if (row.stage === "PAGE_VIEW") entry.visits = row.visitors;
    if (row.stage === "PURCHASE") entry.orders = row.visitors;
    sources.set(row.source, entry);
  }
  const tickets = new Map(data.ticketBySource.map((t) => [t.source, t]));
  const origins = [...sources].sort((a, b) => b[1].orders - a[1].orders || b[1].visits - a[1].visits).slice(0, 8);
  const row = "flex min-h-[30px] items-center justify-between border-t border-rule-soft";
  const orders = (n: number) => `${count(n)} ${n === 1 ? "pedido" : "pedidos"}`;
  return (
    <section className={cn(CARD, "flex flex-[2_1_340px] flex-col gap-3.5")}>
      <div>
        <h2 className={cn(TITLE, "mb-1.5")}>Por canal</h2>
        {channels.map((c) => (
          <div key={c.label} className={row}>
            <span>{c.label}</span>
            <span>
              <span className="font-semibold tabular-nums">{orders(c.n)}</span> <span className="text-ink-3 tabular-nums">· {percent(channelTotal > 0 ? c.n / channelTotal : 0)}</span>
            </span>
          </div>
        ))}
      </div>
      <div>
        <h2 className={cn(TITLE, "mb-1.5")}>Por origem</h2>
        {origins.length === 0 && <div className={cn(row, "text-ink-3")}>Sem visitas no período.</div>}
        {origins.map(([source, v]) => (
          <div key={source} className={row} title={`${count(v.visits)} ${v.visits === 1 ? "visita" : "visitas"}`}>
            <span className="min-w-0 truncate">{sourceLabel(source)}</span>
            <span className="shrink-0">
              <span className="font-semibold tabular-nums">{orders(v.orders)}</span> <span className="text-ink-3 tabular-nums">· ticket {ticketOf(tickets.get(source))}</span>
            </span>
          </div>
        ))}
      </div>
      {data.unattributedOrders > 0 && (
        <WarnNote>
          {count(data.unattributedOrders)} {data.unattributedOrders === 1 ? "pedido sem origem registrada fica" : "pedidos sem origem registrada ficam"} fora do ticket por origem (o ticket da origem fica em &quot;—&quot; quando nenhum pedido dela foi ligado).
        </WarnNote>
      )}
      <div className="flex items-baseline justify-between border-t border-rule pt-2">
        <span className="text-ink-2">Ticket médio</span>
        <span className="font-heading text-xl font-bold tabular-nums">{currency(data.averageTicketCents / 100)}</span>
      </div>
    </section>
  );
}
