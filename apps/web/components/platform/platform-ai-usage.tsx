"use client";

import { type AiUsageProvider, type AiUsageTotals, type PlatformAiUsageDto } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import { AlertCircleIcon, ChevronLeftIcon, ChevronRightIcon, RotateCwIcon, SearchIcon, ShieldIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { PlatformHeader } from "@/components/platform/platform-header";
import { Button } from "@/components/ui/button";
import { count } from "@/lib/format";
import { cn } from "@/lib/utils";

// Board "Gastos com IA": o seletor de mês, o resumo, Claude × Jev, o gasto dia a dia, os modelos e os restaurantes.

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const weekdayFormat = new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone: "UTC" });

/** Dólar: de 1 para cima, duas casas; abaixo, até quatro (centavos somem numa chamada só). */
function usd(value: number): string {
  if (!value) return "US$ 0,00";
  const digits = value >= 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { minimumFractionDigits: 2, maximumFractionDigits: 4 };
  return `US$ ${value.toLocaleString("pt-BR", digits)}`;
}

/** Tokens curtos: "4,95 mi", "412 mil". */
function short(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mi`;
  if (value >= 1_000) return `${count(Math.round(value / 1_000))} mil`;
  return count(value);
}

/** Parte inteira de um total, em %. */
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
/** Com uma casa: "66,0%". */
const pct1 = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%` : "0%");

const tokens = (totals: AiUsageTotals) => totals.inputTokens + totals.outputTokens;
const paidOf = (providers: Partial<Record<AiUsageProvider, AiUsageTotals>>) => (providers.CLAUDE?.costUsd ?? 0) + (providers.JEV?.costUsd ?? 0);
const weekday = (date: string) => weekdayFormat.format(new Date(`${date}T00:00:00Z`)).replace(".", "");

/** O dia de hoje no horário de Brasília: "2026-11-11". */
function today(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function shiftMonth(month: string, delta: number): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, number - 1 + delta, 1)).toISOString().slice(0, 7);
}

function monthLabel(month: string): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return `${MONTHS[number - 1]} de ${year}`;
}

/** "22 de outubro" */
function dayLabel(date: string): string {
  return `${Number(date.slice(8, 10))} de ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
}

const CARD = "rounded-xl border border-rule bg-surface";
const VALUE = "font-heading text-[28px] leading-[1.2] font-bold tracking-[-0.5px] tabular-nums";

/** Uso de IA por mês: o Claude, o Jev e a IA local, dia a dia, por modelo e por restaurante, mais a previsão de 30 dias. */
export function PlatformAiUsage() {
  const { request } = useAuth();
  const [month, setMonth] = useState(() => today().slice(0, 7));
  const usage = useQuery({
    queryKey: ["platform-ai-usage", month],
    queryFn: () => request<PlatformAiUsageDto>(`/platform/ai-usage?month=${month}`),
  });
  const now = today();
  const current = month === now.slice(0, 7);

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-paper">
      <PlatformHeader title="Gastos com IA" />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex max-w-[1040px] flex-col gap-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" aria-label="Mês anterior" onClick={() => setMonth(shiftMonth(month, -1))}>
                <ChevronLeftIcon aria-hidden />
              </Button>
              <div className="min-w-[190px] text-center font-heading text-title font-semibold">{monthLabel(month)}</div>
              <Button variant="outline" size="icon" aria-label="Próximo mês" disabled={current} onClick={() => setMonth(shiftMonth(month, 1))}>
                <ChevronRightIcon aria-hidden />
              </Button>
              {current && (
                <span className="ml-1 rounded-full bg-tomate-lt px-2 py-0.5 text-[12px] font-medium text-tomate-ink">Mês atual · até {dayLabel(now)}</span>
              )}
            </div>
            <div className="text-[12px] text-ink-2">Valores em dólar (US$), até 4 casas</div>
          </div>

          {usage.data ? (
            <Usage data={usage.data} today={current ? now : null} />
          ) : usage.isError ? (
            <ErrorState month={monthLabel(month)} onRetry={() => usage.refetch()} />
          ) : (
            <LoadingState />
          )}
        </div>
      </div>
    </main>
  );
}

function LoadingState() {
  const bars = [3, 5, 0, 4, 6, 8, 7, 5, 0, 9, 11, 6, 4, 7, 10, 12, 8, 0, 6, 9, 13, 34, 7, 5, 0, 8, 10, 12, 9, 6, 4];
  return (
    <div aria-live="polite" className="flex flex-col gap-5">
      <span className="sr-only">Carregando gastos com IA…</span>
      <div className="grid grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className={cn(CARD, "flex h-[118px] flex-col gap-3 p-4")}>
            <div className="h-3 w-[90px] animate-pulse rounded-sm bg-surface-2" />
            <div className="h-7 w-[140px] animate-pulse rounded-sm bg-surface-2" />
            <div className="h-3 w-[110px] animate-pulse rounded-sm bg-surface-2" />
          </div>
        ))}
      </div>
      <div className={cn(CARD, "flex h-[220px] flex-col gap-4 p-6")}>
        <div className="h-4 w-[180px] animate-pulse rounded-sm bg-surface-2" />
        <div className="h-4 w-full animate-pulse rounded-sm bg-surface-2" />
        <div className="grid grid-cols-3 gap-6">
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-20 animate-pulse rounded-lg bg-surface-2" />
          ))}
        </div>
      </div>
      <div className={cn(CARD, "flex h-[300px] flex-col gap-4 p-6")}>
        <div className="h-4 w-40 animate-pulse rounded-sm bg-surface-2" />
        <div className="flex flex-1 items-end gap-1.5">
          {bars.map((bar, index) => (
            <div key={index} className="flex-1 animate-pulse rounded-t-[2px] bg-surface-2" style={{ height: 20 + bar * 4 }} />
          ))}
        </div>
      </div>
      <div className="text-center text-ink-2">Carregando…</div>
    </div>
  );
}

function ErrorState({ month, onRetry }: { month: string; onRetry: () => Promise<unknown> }) {
  return (
    <div role="alert" className={cn(CARD, "flex flex-col items-center gap-3 px-6 py-10 text-center")}>
      <div className="flex size-11 items-center justify-center rounded-full bg-tomate-lt text-tomate">
        <AlertCircleIcon className="size-5" aria-hidden />
      </div>
      <div className="font-heading text-title font-semibold">Não foi possível carregar os gastos</div>
      <div className="max-w-[420px] text-ink-2">
        Os gastos de {month} não chegaram. Verifique a conexão e tente de novo. Se continuar, os provedores podem estar demorando a responder.
      </div>
      <Button className="mt-1" onClick={onRetry}>
        <RotateCwIcon aria-hidden />
        Tentar novamente
      </Button>
    </div>
  );
}

/** `today`: o dia de hoje quando o mês escolhido é o atual. */
function Usage({ data, today }: { data: PlatformAiUsageDto; today: string | null }) {
  // A linha da plataforma (o Jev da defesa da API) fica fora do ranking e da média por restaurante.
  const restaurants = data.tenants.filter((tenant) => tenant.tenantId !== null);
  const platform = data.tenants.find((tenant) => tenant.tenantId === null) ?? null;
  const paid = data.costUsd;
  const restaurantsPaid = restaurants.reduce((sum, tenant) => sum + tenant.costUsd, 0);
  const claudePct = pct(data.providers.CLAUDE.costUsd, paid);
  const jevPct = paid > 0 ? 100 - claudePct : 0;
  const month = monthLabel(data.month);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-4 gap-3">
        <SummaryCard label="Total gasto no mês" value={usd(paid)} detail={`${count(data.calls)} chamadas`} />
        <SummaryCard
          label="Média por dia"
          value={usd(data.days.length ? paid / data.days.length : 0)}
          detail={`dividido por ${data.days.length} dias${today ? " (até hoje)" : ""}`}
        />
        <SummaryCard
          label="Média por restaurante"
          value={usd(restaurants.length ? restaurantsPaid / restaurants.length : 0)}
          detail={`${restaurants.length} ${restaurants.length === 1 ? "restaurante usou" : "restaurantes usaram"} · sem a defesa da API`}
        />
        <div className="flex flex-col gap-1 rounded-xl border border-dashed border-tag-line bg-surface-2 p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[12px] font-medium text-ink-2">Previsão para 30 dias</div>
            <span className="rounded-full border border-rule bg-surface px-[7px] py-px text-[11px] font-medium whitespace-nowrap text-ink-2">
              não muda com o mês
            </span>
          </div>
          <div className={VALUE}>{usd(data.forecast.costUsd)}</div>
          <div className="flex items-center gap-2.5 text-[12px] text-ink-2 tabular-nums">
            <Swatch provider="CLAUDE" size="sm" label={`Claude ${usd(data.forecast.providers.CLAUDE)}`} />
            <Swatch provider="JEV" size="sm" label={`Jev ${usd(data.forecast.providers.JEV)}`} />
          </div>
          <div className="text-[11px] text-ink-2">Média diária dos últimos {data.forecast.basisDays} dias × 30</div>
        </div>
      </div>

      <ProviderSplit data={data} month={month} claudePct={claudePct} jevPct={jevPct} />
      <DailyChart data={data} today={today} month={month} claudePct={claudePct} jevPct={jevPct} />
      <Models data={data} month={month} />
      <Restaurants data={data} restaurants={restaurants} platform={platform} />
    </div>
  );
}

function SummaryCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className={cn(CARD, "flex flex-col gap-1 p-4")}>
      <div className="text-[12px] font-medium text-ink-2">{label}</div>
      <div className={VALUE}>{value}</div>
      <div className="text-[12px] text-ink-2 tabular-nums">{detail}</div>
    </div>
  );
}

const FILL = { CLAUDE: "bg-claude", JEV: "bg-jev" } as const;

/** Quadradinho da cor do provedor (a IA local é só o contorno), com o rótulo ao lado. */
function Swatch({ provider, label, size = "md" }: { provider: AiUsageProvider; label?: ReactNode; size?: "sm" | "md" }) {
  const box = size === "sm" ? "size-2 rounded-[2px]" : "size-2.5 rounded-[3px]";
  return (
    <span className="inline-flex min-w-0 items-center gap-[5px]">
      <span className={cn("shrink-0", box, provider === "LOCAL" ? "border-[1.5px] border-ink-3" : FILL[provider])} aria-hidden />
      {label}
    </span>
  );
}

function ProviderSplit({ data, month, claudePct, jevPct }: { data: PlatformAiUsageDto; month: string; claudePct: number; jevPct: number }) {
  const paid = data.costUsd;
  const local = data.providers.LOCAL;
  const columns = [
    { provider: "CLAUDE" as const, name: "Claude", vendor: "Anthropic", share: claudePct, text: "text-tomate-ink" },
    { provider: "JEV" as const, name: "Jev", vendor: "OpenRouter", share: jevPct, text: "text-jev-ink" },
  ];
  return (
    <section aria-labelledby="sec-split" className={cn(CARD, "flex flex-col gap-4 p-6")}>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 id="sec-split" className="font-heading text-title font-semibold">
            Claude × Jev
          </h2>
          <div className="text-ink-2">Divisão do gasto pago em {month}</div>
        </div>
        <div className="text-right">
          <div className="text-[12px] font-medium text-ink-2">Total pago no mês</div>
          <div className={VALUE}>{usd(paid)}</div>
        </div>
      </div>

      {paid > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between font-medium tabular-nums">
            <span className="text-tomate-ink">Claude {claudePct}%</span>
            <span className="text-jev-ink">Jev {jevPct}%</span>
          </div>
          <div role="img" aria-label={`Claude ${claudePct}% e Jev ${jevPct}% do gasto pago`} className="flex h-4 gap-[2px] overflow-hidden rounded-sm bg-surface">
            {claudePct > 0 && <div className="bg-claude" style={{ width: `${claudePct}%` }} />}
            {jevPct > 0 && <div className="flex-1 bg-jev" />}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between font-medium text-ink-2">
            <span>Claude 0%</span>
            <span>Jev 0%</span>
          </div>
          <div className="h-4 rounded-sm border border-dashed border-tag-line bg-surface-2" />
          <div className="text-[12px] text-ink-2">
            {local.calls ? "Sem gasto pago neste mês: só a IA local foi usada." : "Nenhum uso de IA neste mês."}
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-6 border-t border-rule-soft pt-4">
        {columns.map((column) => {
          const totals = data.providers[column.provider];
          return (
            <div key={column.provider} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Swatch provider={column.provider} />
                <span className="font-semibold">{column.name}</span>
                <span className="text-ink-2">· {column.vendor}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="font-heading text-[22px] font-bold tracking-[-0.3px] tabular-nums">{usd(totals.costUsd)}</span>
                <span className={cn("font-medium tabular-nums", column.text)}>{column.share}% do pago</span>
              </div>
              <Facts
                rows={[
                  ["Chamadas", count(totals.calls)],
                  ["Tokens", count(tokens(totals))],
                  ["Previsão 30 dias", usd(data.forecast.providers[column.provider])],
                ]}
              />
            </div>
          );
        })}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Swatch provider="LOCAL" />
            <span className="font-semibold">IA local</span>
            <span className="text-ink-2">· Ollama</span>
            <span className="ml-auto rounded-full bg-success-lt px-2 py-px text-[11px] font-medium text-success-ink">sem custo</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-heading text-[22px] font-bold tracking-[-0.3px] tabular-nums">{tokens(local) ? short(tokens(local)) : "0"}</span>
            <span className="text-ink-2">tokens</span>
          </div>
          <Facts
            rows={[
              ["Chamadas", count(local.calls)],
              ["Tokens", count(tokens(local))],
              ["Custo", "US$ 0,00"],
            ]}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6 rounded-lg bg-surface-2 px-4 py-3 text-[12px] text-ink-2">
        <div>
          <strong className="font-semibold text-ink">Claude</strong> (Haiku, Anthropic) é o reserva pago: só responde quando a IA local está fora do ar.
        </div>
        <div>
          <strong className="font-semibold text-ink">Jev</strong> (OpenRouter) avalia os atendimentos e analisa os casos da defesa da API.
        </div>
        <div>
          <strong className="font-semibold text-ink">IA local</strong> (gemma no Ollama) faz o grosso do trabalho e não custa nada; aqui só contamos tokens.
        </div>
      </div>
    </section>
  );
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-ink-2 tabular-nums">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <span>{label}</span>
          <span className="text-right text-ink">{value}</span>
        </div>
      ))}
    </div>
  );
}

const CHART_HEIGHT = 200;

/** O teto do eixo: três passos redondos (1, 1,5, 2, 2,5, 3, 4, 5, 6 ou 8 × 10ⁿ) que cobrem o maior valor. */
function axisTop(value: number): number {
  if (value <= 0) return 0.03;
  const raw = value / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((step) => step * power >= raw - 1e-12) ?? 10) * power * 3;
}

type ChartDay = { date: string; future: boolean; claude: number; jev: number; calls: number; local: number };

function DailyChart({ data, today, month, claudePct, jevPct }: { data: PlatformAiUsageDto; today: string | null; month: string; claudePct: number; jevPct: number }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const days: ChartDay[] = data.days.map((day) => ({
    date: day.date,
    future: false,
    claude: day.providers.CLAUDE.costUsd,
    jev: day.providers.JEV.costUsd,
    calls: day.providers.CLAUDE.calls + day.providers.JEV.calls + day.providers.LOCAL.calls,
    local: tokens(day.providers.LOCAL),
  }));
  // No mês atual, os dias que ainda não chegaram ficam marcados até o fim do mês.
  if (today) {
    const [year, number] = data.month.split("-").map(Number) as [number, number];
    const length = new Date(Date.UTC(year, number, 0)).getUTCDate();
    for (let day = days.length + 1; day <= length; day++) {
      days.push({ date: `${data.month}-${String(day).padStart(2, "0")}`, future: true, claude: 0, jev: 0, calls: 0, local: 0 });
    }
  }
  const paid = data.costUsd;
  const forecastDaily = data.forecast.costUsd / 30;
  const showForecast = forecastDaily > 0;
  const peakDay = days.reduce<ChartDay | null>((best, day) => (day.claude + day.jev > (best ? best.claude + best.jev : 0) ? day : best), null);
  const peakTotal = peakDay ? peakDay.claude + peakDay.jev : 0;
  const top = axisTop(Math.max(peakTotal, showForecast ? forecastDaily : 0));
  const height = (value: number) => (value / top) * CHART_HEIGHT;
  const hasCalls = data.calls > 0;

  const peakLine = peakDay
    ? `Dia de maior gasto: ${Number(peakDay.date.slice(8, 10))} ${MONTHS[Number(peakDay.date.slice(5, 7)) - 1]!.slice(0, 3)} (${weekday(peakDay.date)}) · ${usd(peakTotal)} · Claude ${pct(peakDay.claude, peakTotal)}%, Jev ${100 - pct(peakDay.claude, peakTotal)}%`
    : "Nenhum dia com gasto pago neste mês";

  return (
    <section aria-labelledby="sec-dias" className={cn(CARD, "flex flex-col gap-4 p-6")}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="sec-dias" className="font-heading text-title font-semibold">
            Gasto dia a dia
          </h2>
          <div className="text-ink-2 tabular-nums">{peakLine}</div>
        </div>
        <div className="flex shrink-0 items-center gap-4 text-[12px] text-ink-2 tabular-nums">
          <Swatch
            provider="CLAUDE"
            label={
              <span>
                Claude <strong className="font-semibold text-ink">{claudePct}%</strong> do mês
              </span>
            }
          />
          <Swatch
            provider="JEV"
            label={
              <span>
                Jev <strong className="font-semibold text-ink">{jevPct}%</strong>
              </span>
            }
          />
          {showForecast && (
            <span className="inline-flex items-center gap-1.5">
              <span className="w-4 border-t-2 border-dashed border-ink-2" aria-hidden />
              Ritmo da previsão
            </span>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        <div className="relative w-14 shrink-0" style={{ height: CHART_HEIGHT }}>
          {[0, 1, 2, 3].map((tick) => (
            <div
              key={tick}
              className="absolute right-0 text-[11px] text-ink-2 tabular-nums"
              style={{ bottom: Math.max(0, (tick / 3) * CHART_HEIGHT - 8) }}
            >
              {tick ? usd((top * tick) / 3) : "0"}
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="relative" style={{ height: CHART_HEIGHT }} onMouseLeave={() => setHovered(null)}>
            {[0, 1, 2, 3].map((tick) => (
              <div key={tick} className="absolute inset-x-0 border-t border-rule-soft" style={{ bottom: (tick / 3) * CHART_HEIGHT }} />
            ))}
            <div className="absolute inset-0 flex items-stretch gap-1">
              {days.map((day, index) => {
                const claude = height(day.claude);
                const jev = height(day.jev);
                const label = `${dayLabel(day.date)}${day.future ? ": ainda não chegou" : `: ${usd(day.claude + day.jev)}`}`;
                const enter = () => {
                  if (!day.future && hasCalls) setHovered(index);
                };
                return (
                  <button
                    key={day.date}
                    type="button"
                    aria-label={label}
                    onMouseEnter={enter}
                    onFocus={enter}
                    onBlur={() => setHovered(null)}
                    className={cn(
                      "flex h-full min-w-0 flex-1 cursor-default flex-col justify-end rounded-t-[3px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink",
                      hovered === index && "bg-surface-2",
                    )}
                  >
                    {jev > 0 && <span className="block rounded-t-[2px] bg-jev" style={{ height: jev }} />}
                    {jev > 0 && claude > 0 && <span className="block h-px" />}
                    {claude > 0 && <span className={cn("block bg-claude", jev === 0 && "rounded-t-[2px]")} style={{ height: claude }} />}
                    {day.future && <span className="block h-px border-t border-dashed border-tag-line" />}
                  </button>
                );
              })}
            </div>
            {showForecast && (
              <>
                <div className="pointer-events-none absolute inset-x-0 border-t-2 border-dashed border-ink-2" style={{ bottom: height(forecastDaily) }} />
                <div
                  className="pointer-events-none absolute right-0 bg-surface px-1 text-[11px] text-ink-2 tabular-nums"
                  style={{ bottom: height(forecastDaily) + 3 }}
                >
                  previsão · {usd(forecastDaily)}/dia
                </div>
              </>
            )}
            {paid === 0 && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="rounded-lg bg-surface-2 px-3.5 py-2 text-ink-2">
                  {data.providers.LOCAL.calls ? `Sem gasto pago em ${month} · passe o mouse para ver a IA local` : `Nenhum uso de IA em ${month}`}
                </div>
              </div>
            )}
            {hovered !== null && days[hovered] && <DayTooltip day={days[hovered]!} index={hovered} length={days.length} />}
          </div>
          <div className="flex gap-1 border-t border-rule pt-1">
            {days.map((day, index) => {
              const number = index + 1;
              const isToday = day.date === today;
              const shown = isToday || number === 1 || number % 5 === 0 || number === days.length;
              return (
                <div
                  key={day.date}
                  className={cn(
                    "min-w-0 flex-1 text-center text-[11px] whitespace-nowrap tabular-nums",
                    day.future ? "text-ink-3" : isToday ? "font-semibold text-tomate-ink" : "text-ink-2",
                  )}
                >
                  {isToday ? "hoje" : shown ? number : ""}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function DayTooltip({ day, index, length }: { day: ChartDay; index: number; length: number }) {
  const total = day.claude + day.jev;
  const claudePct = pct(day.claude, total);
  // Ao lado da barra; perto da borda direita, passa para o lado esquerdo.
  const center = ((index + 0.5) / length) * 100;
  const side = center < 70 ? { left: `calc(${center}% + 12px)` } : { right: `calc(${100 - center}% + 12px)` };
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute top-0 z-10 flex w-[228px] flex-col gap-1.5 rounded-xl border border-rule bg-surface p-3 shadow-[0_8px_24px_rgba(26,24,20,.14)]"
      style={side}
    >
      <div className="flex justify-between gap-2">
        <span className="font-semibold">
          {dayLabel(day.date)} · {weekday(day.date)}
        </span>
        <span className="font-semibold tabular-nums">{total ? usd(total) : "sem gasto"}</span>
      </div>
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-[3px] text-ink-2 tabular-nums">
        <Swatch provider="CLAUDE" size="sm" />
        <span>Claude</span>
        <span className="text-right text-ink">
          {usd(day.claude)} · {claudePct}%
        </span>
        <Swatch provider="JEV" size="sm" />
        <span>Jev</span>
        <span className="text-right text-ink">
          {usd(day.jev)} · {total ? 100 - claudePct : 0}%
        </span>
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-y-0.5 border-t border-rule-soft pt-1.5 text-ink-2 tabular-nums">
        <span>Chamadas</span>
        <span className="text-right text-ink">{count(day.calls)}</span>
        <span>IA local</span>
        <span className="text-right text-ink">{count(day.local)} tokens</span>
      </div>
    </div>
  );
}

const MODEL_COLS = "grid grid-cols-[1.5fr_1.4fr_0.8fr_1fr_0.9fr_1.2fr] gap-4";
const PROVIDER_NAME = { CLAUDE: "Claude · Anthropic", JEV: "Jev · OpenRouter", LOCAL: "IA local · Ollama" } as const;

function Models({ data, month }: { data: PlatformAiUsageDto; month: string }) {
  return (
    <section aria-labelledby="sec-modelos" className={cn(CARD, "flex flex-col gap-3 p-6")}>
      <h2 id="sec-modelos" className="font-heading text-title font-semibold">
        Por modelo
      </h2>
      <div>
        <div className={cn(MODEL_COLS, "border-b border-rule py-2 text-[12px] font-medium text-ink-2")}>
          <span>Modelo</span>
          <span>Provedor</span>
          <span className="text-right">Chamadas</span>
          <span className="text-right">Tokens</span>
          <span className="text-right">Custo</span>
          <span className="text-right">% do total</span>
        </div>
        {data.models.map((model) => {
          const share = data.costUsd > 0 ? (model.costUsd / data.costUsd) * 100 : 0;
          return (
            <div key={`${model.provider}:${model.model}`} className={cn(MODEL_COLS, "min-h-11 items-center border-b border-rule-soft tabular-nums")}>
              <code className="truncate font-mono text-[12px]" title={model.model}>
                {model.model}
              </code>
              <span className="min-w-0 truncate">
                <Swatch provider={model.provider} size="sm" label={<span className="truncate">{PROVIDER_NAME[model.provider]}</span>} />
              </span>
              <span className="text-right">{count(model.calls)}</span>
              <span
                title={`Entrada ${count(model.inputTokens)} · Saída ${count(model.outputTokens)}`}
                className="cursor-help text-right underline decoration-ink-3 decoration-dotted underline-offset-[3px]"
              >
                {count(tokens(model))}
              </span>
              <span className="text-right font-medium">{usd(model.costUsd)}</span>
              <span className="flex items-center justify-end gap-2">
                <span className="h-1.5 w-16 overflow-hidden rounded-[3px] bg-surface-2">
                  {model.provider !== "LOCAL" && <span className={cn("block h-full", FILL[model.provider])} style={{ width: `${share}%` }} />}
                </span>
                <span className="w-11 text-right">{pct1(model.costUsd, data.costUsd)}</span>
              </span>
            </div>
          );
        })}
        {data.models.length === 0 && <div className="py-7 text-center text-ink-2">Nenhuma chamada de IA em {month}.</div>}
        <div className="pt-2 text-[12px] text-ink-2">Passe o mouse nos tokens para ver entrada e saída.</div>
      </div>
    </section>
  );
}

type TenantRow = PlatformAiUsageDto["tenants"][number];
const REST_COLS = "grid grid-cols-[36px_240px_1fr_150px_96px] gap-4";

function Restaurants({ data, restaurants, platform }: { data: PlatformAiUsageDto; restaurants: TenantRow[]; platform: TenantRow | null }) {
  const [query, setQuery] = useState("");
  const monthName = MONTHS[Number(data.month.slice(5, 7)) - 1];
  const top = Math.max(Number.EPSILON, ...restaurants.map((tenant) => tenant.costUsd), platform?.costUsd ?? 0);
  const search = query.trim().toLowerCase();
  const shown = restaurants.filter((tenant) => !search || tenant.tenantName.toLowerCase().includes(search));

  return (
    <section aria-labelledby="sec-rest" className={cn(CARD, "flex flex-col gap-3 p-6")}>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 id="sec-rest" className="font-heading text-title font-semibold">
            Restaurantes que mais consumiram
          </h2>
          <div className="text-ink-2 tabular-nums">
            {restaurants.length ? `${restaurants.length} ${restaurants.length === 1 ? "restaurante usou" : "restaurantes usaram"} IA em ${monthName}` : `Nenhum restaurante usou IA em ${monthName}`}
          </div>
        </div>
        <label className="flex h-9 w-[260px] items-center gap-2 rounded-lg border border-rule bg-surface px-2.5 text-ink-2 focus-within:border-ink focus-within:shadow-[0_0_0_3px_rgba(26,24,20,.08)]">
          <SearchIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="sr-only">Buscar restaurante</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar restaurante"
            className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-3"
          />
        </label>
      </div>

      <div className={cn(REST_COLS, "border-b border-rule py-2 text-[12px] font-medium text-ink-2")}>
        <span>#</span>
        <span>Restaurante</span>
        <span>Gasto (Claude · Jev)</span>
        <span className="text-right">Chamadas · tokens</span>
        <span className="text-right">Custo</span>
      </div>

      <div className="flex flex-col">
        {shown.map((tenant) => {
          const paid = paidOf(tenant.providers);
          const claude = tenant.providers.CLAUDE?.costUsd ?? 0;
          const jev = tenant.providers.JEV?.costUsd ?? 0;
          const local = tenant.providers.LOCAL ? tokens(tenant.providers.LOCAL) : 0;
          const claudePct = pct(claude, paid);
          return (
            <div key={tenant.tenantId} className="flex flex-col gap-1 border-b border-rule-soft py-3">
              <div className={cn(REST_COLS, "items-center tabular-nums")}>
                <span className="font-heading text-[15px] font-semibold text-ink-2">{restaurants.indexOf(tenant) + 1}º</span>
                <span className="truncate font-medium" title={tenant.tenantName}>
                  {tenant.tenantName}
                </span>
                <span className="block h-2.5 overflow-hidden rounded-[3px] bg-surface-2">
                  <span className="flex h-full gap-px" style={{ width: `${(paid / top) * 100}%` }}>
                    {claude > 0 && <span className="bg-claude" style={{ width: `${(claude / paid) * 100}%` }} />}
                    {jev > 0 && <span className="flex-1 bg-jev" />}
                  </span>
                </span>
                <span className="text-right text-ink-2">
                  {count(tenant.calls)} · {short(tokens(tenant))} tok
                </span>
                <span className={cn("text-right font-semibold", paid ? "text-ink" : "text-ink-2")}>{usd(tenant.costUsd)}</span>
              </div>
              <div className="grid grid-cols-[36px_1fr] gap-4 text-[12px] text-ink-2 tabular-nums">
                <span />
                <span className="truncate">
                  {paid
                    ? `Claude ${usd(claude)} (${claudePct}%) · Jev ${usd(jev)} (${100 - claudePct}%) · IA local ${count(local)} tokens · ${pct(paid, data.costUsd)}% do gasto do mês`
                    : `Só IA local · ${count(local)} tokens · sem gasto pago`}
                </span>
              </div>
            </div>
          );
        })}

        {shown.length === 0 && (
          <div className="py-8 text-center text-ink-2">
            {restaurants.length ? `Nenhum restaurante com “${query.trim()}”.` : `Nenhum restaurante usou IA em ${monthLabel(data.month)}.`}
          </div>
        )}

        {platform && platform.costUsd > 0 && !search && (
          <div className="mt-3 flex flex-col gap-1 rounded-lg border border-dashed border-tag-line bg-surface-2 p-3">
            <div className="grid grid-cols-[24px_240px_1fr_150px_96px] items-center gap-4 tabular-nums">
              <ShieldIcon className="size-[18px] text-ink-2" aria-hidden />
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium" title="Plataforma (defesa da API)">
                  Plataforma (defesa da API)
                </span>
                <span className="shrink-0 rounded-sm border border-dashed border-tag-line px-1.5 text-[11px] text-ink-2">não é restaurante</span>
              </span>
              <span className="block h-2.5 overflow-hidden rounded-[3px] bg-surface">
                <span className="block h-full bg-jev" style={{ width: `${(platform.costUsd / top) * 100}%` }} />
              </span>
              <span className="text-right text-ink-2">
                {count(platform.calls)} · {short(tokens(platform))} tok
              </span>
              <span className="text-right font-semibold">{usd(platform.costUsd)}</span>
            </div>
            <div className="grid grid-cols-[24px_1fr] gap-4 text-[12px] text-ink-2 tabular-nums">
              <span />
              <span>
                Jev {usd(platform.costUsd)} (100%) · gasto da plataforma, fora da média por restaurante · {pct(platform.costUsd, data.costUsd)}% do gasto do mês
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-[12px] text-ink-2 tabular-nums">
        <span>
          Mostrando {shown.length} de {restaurants.length} restaurantes
        </span>
        <span>Ordenado do maior para o menor gasto</span>
      </div>
    </section>
  );
}
