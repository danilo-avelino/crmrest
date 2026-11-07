"use client";

import { DEVICE_LABEL, type PlatformTrafficDto, TRAFFIC_PERIODS, type TrafficPeriod } from "@dishdesk/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { LightbulbIcon } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { PlatformHeader, PlatformLoading } from "@/components/platform/platform-header";
import { BarRow, Card, Chip, Metric, Row, SectionLabel, share, Table } from "@/components/reports/report-ui";
import { count } from "@/lib/format";
import { cn } from "@/lib/utils";

/** "+32%", "−8%" ou "igual" em relação ao período anterior. */
function change(current: number, previous: number, days: number): string {
  if (previous === 0) return current === 0 ? `Igual aos ${days} dias anteriores` : `Sem dados nos ${days} dias anteriores`;
  const delta = Math.round(((current - previous) / previous) * 100);
  if (delta === 0) return `Igual aos ${days} dias anteriores`;
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta)}% vs ${days} dias anteriores (${count(previous)})`;
}

/** "07/11" a partir de "2026-11-07". */
function shortDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${day}/${month}`;
}

/** Teto do eixo: um número redondo acima do maior valor. */
function niceMax(value: number): number {
  if (value <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / step) * step;
}

type Column = { key: string; label: string; value: number; detail: string };

/** Colunas de uma série só, com a linha de base, o teto do eixo e o número de cada coluna ao passar o mouse ou focar. */
function ColumnChart({ columns, ticks, height = 160 }: { columns: Column[]; ticks: string[]; height?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const top = niceMax(Math.max(0, ...columns.map((column) => column.value)));
  const current = active === null ? null : columns[active];

  return (
    <div className="relative">
      <div className="flex gap-2">
        <div className="flex w-8 shrink-0 flex-col justify-between text-right text-[11px] text-ink-3 tabular-nums" style={{ height }}>
          <span className="-translate-y-1/2">{count(top)}</span>
          <span className="-translate-y-1/2">{count(top / 2)}</span>
          <span className="translate-y-1/2">0</span>
        </div>
        <div className="relative min-w-0 flex-1" style={{ height }} onPointerLeave={() => setActive(null)}>
          <div className="absolute inset-x-0 top-0 border-t border-rule-soft" />
          <div className="absolute inset-x-0 top-1/2 border-t border-rule-soft" />
          <div className="absolute inset-x-0 bottom-0 border-t border-rule" />
          <div className="absolute inset-0 flex items-end">
            {columns.map((column, index) => (
              <div
                key={column.key}
                tabIndex={0}
                role="img"
                aria-label={`${column.label}: ${column.detail}`}
                className="flex h-full min-w-0 flex-1 items-end justify-center px-px outline-none"
                onPointerEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                onBlur={() => setActive(null)}
              >
                <div
                  className={cn("w-full max-w-6 rounded-t-[4px] bg-tomate transition-opacity", active !== null && active !== index && "opacity-45")}
                  style={{ height: `${top ? (column.value / top) * 100 : 0}%` }}
                />
              </div>
            ))}
          </div>
          {current && active !== null && (
            <div
              className="pointer-events-none absolute -top-2 z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-rule bg-surface px-2.5 py-1.5 text-[12px] whitespace-nowrap shadow-sm"
              style={{ left: `${((active + 0.5) / columns.length) * 100}%` }}
            >
              <div className="font-semibold tabular-nums">{current.detail}</div>
              <div className="text-ink-3">{current.label}</div>
            </div>
          )}
        </div>
      </div>
      <div className="mt-1.5 ml-10 flex justify-between text-[11px] text-ink-3 tabular-nums">
        {ticks.map((tick, index) => (
          <span key={index}>{tick}</span>
        ))}
      </div>
    </div>
  );
}

/** Tráfego do site institucional: visitantes, origens, páginas, aparelhos, horários e as conclusões do período. */
export function PlatformTraffic() {
  const { request } = useAuth();
  const [days, setDays] = useState<TrafficPeriod>(30);
  const traffic = useQuery({
    queryKey: ["platform-traffic", days],
    queryFn: () => request<PlatformTrafficDto>(`/platform/traffic?days=${days}`),
    placeholderData: keepPreviousData,
  });
  const data = traffic.data;

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
      <PlatformHeader title="Tráfego do site" />
      <div className="flex-1 overflow-y-auto bg-paper px-7 py-6">
        <div className="flex max-w-[1080px] flex-col gap-4">
          <div className="flex items-center gap-2">
            {TRAFFIC_PERIODS.map((period) => (
              <Chip key={period} active={days === period} onClick={() => setDays(period)}>
                Últimos {period} dias
              </Chip>
            ))}
            <span className="ml-auto text-xs text-ink-3">www.dishdesk.com.br · sem cookies, visitante contado por dia</span>
          </div>

          {data ? (
            <div className={cn("flex flex-col gap-4 transition-opacity", traffic.isPlaceholderData && "opacity-60")}>
              <TrafficBody data={data} />
            </div>
          ) : (
            <PlatformLoading failed={traffic.isError} />
          )}
        </div>
      </div>
    </main>
  );
}

function TrafficBody({ data }: { data: PlatformTrafficDto }) {
  const { totals, previous, days } = data;
  const dailyTicks = [data.daily[0], data.daily[Math.floor(data.daily.length / 2)], data.daily.at(-1)].map((day) => (day ? shortDate(day.date) : ""));
  const topSource = Math.max(0, ...data.sources.map((row) => row.visitors));
  const topDevice = Math.max(0, ...data.devices.map((row) => row.visitors));

  return (
    <>
      <Card>
        <div className="flex items-center gap-2">
          <LightbulbIcon className="size-4 text-tomate" aria-hidden />
          <h2 className="font-heading text-title font-semibold">O que os números dizem</h2>
        </div>
        <ul className="mt-2.5 flex flex-col gap-1.5">
          {data.insights.map((insight) => (
            <li key={insight} className="flex gap-2 text-ink-2">
              <span className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-3" aria-hidden />
              {insight}
            </li>
          ))}
        </ul>
      </Card>

      <div className="grid grid-cols-4 gap-3">
        <Metric label="Visitantes" value={count(totals.visitors)} detail={change(totals.visitors, previous.visitors, days)} />
        <Metric label="Páginas vistas" value={count(totals.pageviews)} detail={change(totals.pageviews, previous.pageviews, days)} />
        <Metric label='Cliques em "Teste grátis"' value={count(totals.ctaClicks)} detail={change(totals.ctaClicks, previous.ctaClicks, days)} />
        <Metric
          label="Cadastros do teste grátis"
          value={count(totals.signups)}
          detail={totals.visitors ? `${share(totals.signups, totals.visitors)} dos visitantes · ${change(totals.signups, previous.signups, days)}` : change(totals.signups, previous.signups, days)}
        />
      </div>

      <Card>
        <SectionLabel>Visitantes por dia</SectionLabel>
        <ColumnChart
          ticks={dailyTicks}
          columns={data.daily.map((day) => ({
            key: day.date,
            label: shortDate(day.date),
            value: day.visitors,
            detail: `${count(day.visitors)} ${day.visitors === 1 ? "visitante" : "visitantes"} · ${count(day.pageviews)} ${day.pageviews === 1 ? "página" : "páginas"}`,
          }))}
        />
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <SectionLabel>De onde vêm os visitantes</SectionLabel>
          {data.sources.length === 0 ? (
            <p className="py-2 text-ink-3">Sem visitas no período.</p>
          ) : (
            data.sources.map((row) => (
              <BarRow key={row.source} label={row.source} value={row.visitors} max={topSource} labelWidth="140px" text={`${share(row.visitors, totals.visitors)} · ${count(row.visitors)}`} />
            ))
          )}
        </Card>
        <Card>
          <SectionLabel>Aparelhos</SectionLabel>
          {data.devices.length === 0 ? (
            <p className="py-2 text-ink-3">Sem visitas no período.</p>
          ) : (
            data.devices.map((row) => (
              <BarRow key={row.device} label={DEVICE_LABEL[row.device]} value={row.visitors} max={topDevice} labelWidth="140px" text={`${share(row.visitors, totals.visitors)} · ${count(row.visitors)}`} />
            ))
          )}
          <SectionLabel className="mt-5">Visitas por hora do dia</SectionLabel>
          <ColumnChart
            height={96}
            ticks={["0h", "6h", "12h", "18h", "23h"]}
            columns={data.hours.map((views, hour) => ({
              key: String(hour),
              label: `Das ${hour}h às ${(hour + 1) % 24}h`,
              value: views,
              detail: `${count(views)} ${views === 1 ? "página vista" : "páginas vistas"}`,
            }))}
          />
        </Card>
      </div>

      <div>
        <SectionLabel>Páginas mais vistas</SectionLabel>
        <Table cols="minmax(0,1fr) 140px 140px" head={["Página", "Páginas vistas", "Visitantes"]} empty={<p className="px-[18px] py-4 text-ink-3">Sem visitas no período.</p>}>
          {data.pages.map((page) => (
            <Row key={page.path}>
              <span className="truncate font-medium">{page.path}</span>
              <span className="tabular-nums">{count(page.pageviews)}</span>
              <span className="tabular-nums">{count(page.visitors)}</span>
            </Row>
          ))}
        </Table>
      </div>
    </>
  );
}
