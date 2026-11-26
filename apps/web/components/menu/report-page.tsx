"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon, ArrowDownRightIcon, ArrowUpRightIcon, DownloadIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { BLOCK, ErrorNote, loadError, MenuPage, PageHeader } from "@/components/menu/bits";
import { useTenantId } from "@/components/menu/use-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { money } from "@/lib/menu";
import { changePct, hourText, plural, type ReportRow, reportCsv, type SalesReport, shortDate } from "@/lib/menu-backstage";
import { cn } from "@/lib/utils";

type Preset = "today" | "yesterday" | "7d" | "30d" | "custom";
const PRESET_LABEL: Record<Preset, string> = { today: "Hoje", yesterday: "Ontem", "7d": "7 dias", "30d": "30 dias", custom: "Personalizado" };
type Tab = "categories" | "items" | "options";
const TAB_LABEL: Record<Tab, string> = { categories: "Categorias", items: "Itens", options: "Opções" };
const ROW_LABEL: Record<Tab, string> = { categories: "Categoria", items: "Item", options: "Opção" };

/** Dia de Brasília (AAAA-MM-DD) de hoje menos `back` dias. */
function brtDay(back = 0): string {
  return new Date(Date.now() - 3 * 3_600_000 - back * 86_400_000).toISOString().slice(0, 10);
}

function rangeOf(preset: Preset, custom: { from: string; to: string }): { from: string; to: string } {
  if (preset === "today") return { from: brtDay(), to: brtDay() };
  if (preset === "yesterday") return { from: brtDay(1), to: brtDay(1) };
  if (preset === "7d") return { from: brtDay(6), to: brtDay() };
  if (preset === "30d") return { from: brtDay(29), to: brtDay() };
  return custom;
}

/** N3: faturamento do cardápio digital e do WhatsApp com IA, com a conta explícita e as vendas por categoria, item e opção. */
export function ReportPage() {
  const { request } = useAuth();
  const tenantId = useTenantId();
  const [preset, setPreset] = useState<Preset>("today");
  const [custom, setCustom] = useState({ from: brtDay(6), to: brtDay() });
  const [tab, setTab] = useState<Tab>("items");
  const range = rangeOf(preset, custom);
  const report = useQuery({
    queryKey: ["menu-report", tenantId, range.from, range.to],
    queryFn: () => request<SalesReport>(`/menu/${tenantId}/report?from=${range.from}&to=${range.to}`),
    enabled: Boolean(tenantId) && range.from <= range.to,
    retry: false,
  });

  const exportCsv = () => {
    if (!report.data) return;
    const rows = { categories: report.data.categories, items: report.data.items, options: report.data.options }[tab];
    const blob = new Blob([`﻿${reportCsv(rows, ROW_LABEL[tab])}`], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `vendas-${TAB_LABEL[tab].toLowerCase()}-${range.from}-a-${range.to}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const header = (
    <PageHeader title="Relatório de vendas" description="Pedidos do cardápio digital e do WhatsApp com IA. Pedidos cancelados não entram.">
      <Button variant="outline" disabled={!report.data} onClick={exportCsv}>
        <DownloadIcon aria-hidden /> Exportar CSV
      </Button>
    </PageHeader>
  );

  const periods = (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Período">
      {(Object.keys(PRESET_LABEL) as Preset[]).map((p) => (
        <button
          key={p}
          type="button"
          aria-pressed={preset === p}
          onClick={() => setPreset(p)}
          className={cn("h-8 rounded-md border px-3 text-[13px]", preset === p ? "border-ink bg-ink font-semibold text-paper" : "border-rule bg-surface text-ink-2 hover:bg-paper")}
        >
          {PRESET_LABEL[p]}
        </button>
      ))}
      {preset === "custom" && (
        <span className="flex items-center gap-1.5">
          <Input type="date" aria-label="De" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="h-8 w-36" />
          <span className="text-ink-3">a</span>
          <Input type="date" aria-label="Até" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="h-8 w-36" />
        </span>
      )}
    </div>
  );

  if (report.isPending) {
    return (
      <MenuPage>
        {header}
        <div className={cn(BLOCK, "p-8 text-center text-ink-3")} aria-busy>
          Carregando o relatório…
        </div>
      </MenuPage>
    );
  }
  if (report.isError) {
    const failure = loadError(report.error);
    return (
      <MenuPage>
        {header}
        <ErrorNote action={!failure.forbidden && <Button size="sm" variant="outline" onClick={() => report.refetch()}>Tentar de novo</Button>}>
          {failure.forbidden ? failure.text : `Não foi possível carregar o relatório. ${failure.text}`}
        </ErrorNote>
      </MenuPage>
    );
  }

  const data = report.data;
  const { totals } = data;
  const isToday = preset === "today";
  const label = isToday ? `hoje, até ${hourText(data.until)}` : data.from === data.to ? shortDate(data.from) : `${shortDate(data.from)} a ${shortDate(data.to)}`;
  const delta = changePct(totals.revenueCents, data.previous.revenueCents);
  const compareText = isToday ? `vs. ontem até as ${hourText(data.previous.until)}` : "vs. o período anterior";
  return (
    <MenuPage>
      {header}
      <section className={cn(BLOCK, "flex flex-col gap-4 px-5 py-4")}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="mr-auto text-[12.5px] text-ink-2">Faturamento · {label}</span>
          {periods}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="font-heading text-[44px] leading-none font-bold tracking-[-1px] tabular-nums">{money(totals.revenueCents)}</span>
          {delta != null && (
            <span className={cn("inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[12px] font-semibold", delta >= 0 ? "bg-success-lt text-success-ink" : "bg-tomate-lt text-tomate-ink")}>
              {delta >= 0 ? <ArrowUpRightIcon className="size-3" aria-hidden /> : <ArrowDownRightIcon className="size-3" aria-hidden />}
              {delta >= 0 ? "+" : ""}
              {delta.toLocaleString("pt-BR")}%
            </span>
          )}
          <span className="text-ink-2">
            {compareText} ({money(data.previous.revenueCents)})
          </span>
        </div>
        {totals.orders === 0 ? (
          <div className="flex flex-wrap items-center gap-3 border-t border-rule pt-3 text-ink-2">
            <span className="flex-1">Nenhum pedido neste período. Os números aparecem assim que o primeiro pedido do cardápio chegar.</span>
            {preset !== "30d" && (
              <Button size="sm" variant="outline" onClick={() => setPreset("30d")}>
                Ver os últimos 30 dias
              </Button>
            )}
            <Link href="/cardapio/entrega" className="text-[13px] font-medium underline">
              Conferir se o cardápio está no ar
            </Link>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-4">
            <Piece label="Produtos" value={totals.productsCents} />
            <Sign>+</Sign>
            <Piece label="Taxas de entrega" value={totals.feesCents} />
            <Sign>−</Sign>
            <Piece label="Descontos (cupons)" value={totals.discountsCents} tone="tomate" />
            <Sign>=</Sign>
            <Piece label="Faturamento" value={totals.revenueCents} dark />
            <div className="ml-auto flex gap-6 pr-1">
              <span className="flex flex-col items-center">
                <strong className="text-[15px] tabular-nums">{totals.orders}</strong>
                <span className="text-[12px] text-ink-3">{totals.orders === 1 ? "pedido" : "pedidos"}</span>
              </span>
              <span className="flex flex-col items-center">
                <strong className="text-[15px] tabular-nums">{money(totals.averageCents)}</strong>
                <span className="text-[12px] text-ink-3">por pedido</span>
              </span>
            </div>
          </div>
        )}
      </section>

      {totals.orders > 0 && <Chart data={data} isToday={isToday} />}
      {totals.orders > 0 && <Breakdown data={data} tab={tab} onTab={setTab} />}
    </MenuPage>
  );
}

function Sign({ children }: { children: string }) {
  return <span className="w-4 text-center text-[16px] text-ink-3">{children}</span>;
}

function Piece({ label, value, tone, dark }: { label: string; value: number; tone?: "tomate"; dark?: boolean }) {
  return (
    <div className={cn("min-w-40 rounded-lg px-3 py-2", dark ? "bg-ink text-paper" : "bg-surface-2")}>
      <div className={cn("text-[12px]", dark ? "text-[#C4BDB2]" : "text-ink-2")}>{label}</div>
      <div className={cn("text-[16px] font-semibold tabular-nums", tone === "tomate" && "text-tomate")}>{money(value)}</div>
    </div>
  );
}

/** Barras do período (hoje em tinta, a comparação vazada); a maior de hoje em tomate. */
function Chart({ data, isToday }: { data: SalesReport; isToday: boolean }) {
  const hourly = data.grouping === "hour";
  const { current, previous } = data.series;
  // Por hora, mostra das 11h às 23h quando o restaurante não vende de madrugada.
  const first = hourly ? Math.min(11, ...current.map((v, i) => (v || previous[i] ? i : 24))) : 0;
  const indexes = current.map((_, i) => i).filter((i) => i >= first);
  const max = Math.max(1, ...current, ...previous);
  const peak = current.indexOf(Math.max(...current));
  const nowHour = isToday ? Number(hourText(data.until).replace(/h.*/, "")) : 24;
  const label = (i: number) => (hourly ? `${i}h` : shortDate(new Date(Date.parse(`${data.from}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10)));
  const future = isToday ? indexes.filter((i) => i > nowHour) : [];
  return (
    <section className={cn(BLOCK, "flex flex-col gap-3 px-5 py-4")} aria-label={hourly ? "Faturamento por hora" : "Faturamento por dia"}>
      <div className="flex items-center gap-4">
        <h2 className="mr-auto font-heading text-title font-semibold">{hourly ? "Faturamento por hora" : "Faturamento por dia"}</h2>
        <span className="flex items-center gap-1.5 text-[12.5px]">
          <span className="size-2.5 bg-ink" aria-hidden /> {isToday ? "Hoje" : "Período"}
        </span>
        <span className="flex items-center gap-1.5 text-[12.5px]">
          <span className="size-2.5 border border-ink-3" aria-hidden /> {isToday ? "Ontem" : "Período anterior"}
        </span>
      </div>
      <div className="flex h-52 items-end gap-1 border-b border-rule">
        {indexes.map((i) => (
          <div key={i} className="flex h-full flex-1 flex-col justify-end">
            {i === peak && current[i]! > 0 && <span className="mb-1 text-center text-[11px] font-semibold tabular-nums">{money(current[i]!).replace(/,\d{2}$/, "")}</span>}
            <div className="flex h-full items-end justify-center gap-[3px]">
              {!(isToday && i > nowHour) && current[i]! > 0 && (
                <div title={`${label(i)}: ${money(current[i]!)}`} className={cn("w-[38%] max-w-5", i === peak ? "bg-tomate" : "bg-ink")} style={{ height: `${(current[i]! / max) * 100}%` }} />
              )}
              {(previous[i] ?? 0) > 0 && (
                <div title={`${label(i)} (antes): ${money(previous[i]!)}`} className="w-[38%] max-w-5 border border-ink-3 bg-surface" style={{ height: `${(previous[i]! / max) * 100}%` }} />
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-1">
        {indexes.map((i) => (
          <span key={i} className={cn("flex-1 text-center text-[11px] text-ink-3 tabular-nums", isToday && i === nowHour && "font-semibold text-ink")}>
            {indexes.length > 16 && i % 2 ? "" : label(i)}
          </span>
        ))}
      </div>
      {future.length > 0 && (
        <p className="text-[12px] text-ink-3">
          {future.length === 1 ? `${future[0]}h ainda não aconteceu hoje: aparece só a barra de ontem.` : `${future.length === 2 ? `${future[0]}h e ${future[1]}h` : `Das ${future[0]}h às ${future.at(-1)}h`} ainda não ${future.length === 2 ? "aconteceram" : "aconteceu"} hoje: aparecem só as barras de ontem.`}
        </p>
      )}
    </section>
  );
}

function Breakdown({ data, tab, onTab }: { data: SalesReport; tab: Tab; onTab: (t: Tab) => void }) {
  const [all, setAll] = useState(false);
  const rows: ReportRow[] = { categories: data.categories, items: data.items, options: data.options }[tab];
  const noCost = rows.filter((r) => r.costCents == null).length;
  const withCost = rows.filter((r) => r.costCents != null && r.revenueCents > 0);
  const marginAvg = withCost.length ? Math.round((withCost.reduce((s, r) => s + (r.revenueCents - r.costCents!), 0) / withCost.reduce((s, r) => s + r.revenueCents, 0)) * 100) : null;
  const shown = all ? rows : rows.slice(0, 10);
  const total = rows.reduce((s, r) => s + r.revenueCents, 0);
  return (
    <section className={BLOCK} aria-label="Vendas por categoria, item e opção">
      <div className="flex gap-1 border-b border-rule px-3" role="tablist">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => onTab(t)}
            className={cn("-mb-px border-b-2 px-3.5 py-3 text-[13px]", tab === t ? "border-ink font-semibold text-ink" : "border-transparent text-ink-2")}
          >
            {TAB_LABEL[t]} <span className="text-ink-3 tabular-nums">{({ categories: data.categories, items: data.items, options: data.options })[t].length}</span>
          </button>
        ))}
      </div>
      {noCost > 0 && (
        <div className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-warning-lt px-3 py-2 text-[12.5px] text-warning-ink">
          <AlertTriangleIcon className="size-3.5" aria-hidden />
          <span className="flex-1">
            <strong>{plural(noCost, tab === "options" ? "opção sem custo cadastrado" : tab === "categories" ? "categoria com item sem custo" : "item sem custo cadastrado", tab === "options" ? "opções sem custo cadastrado" : tab === "categories" ? "categorias com item sem custo" : "itens sem custo cadastrado")}.</strong>{" "}
            A margem {noCost === 1 ? "dele" : "deles"} aparece como &ldquo;sem custo&rdquo; e não entra na margem média.
          </span>
          <Link href={tab === "options" ? "/cardapio/opcoes" : "/cardapio/planilha"} className="font-medium underline">
            {tab === "options" ? "Preencher nas opções" : "Preencher na planilha"}
          </Link>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-ink-3">{tab === "options" ? "Nenhuma opção escolhida nos pedidos do período." : "Nada vendido no período."}</p>
      ) : (
        <table className="mt-1 w-full text-[13px]">
          <thead className="text-[12px] text-ink-3">
            <tr className="border-b border-rule">
              <th className="py-2.5 pl-4 text-left font-medium">{ROW_LABEL[tab]}</th>
              <th className="text-right font-medium">Quantidade</th>
              <th className="text-right font-medium">Faturamento</th>
              <th className="text-right font-medium">Preço médio</th>
              <th className="text-right font-medium">Custo total</th>
              <th className="pr-4 text-right font-medium">Margem</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-rule-soft">
                <td className="py-2.5 pl-4 font-semibold">{r.name}</td>
                <td className="text-right tabular-nums">{r.quantity}</td>
                <td className="text-right font-semibold tabular-nums">{money(r.revenueCents)}</td>
                <td className="text-right tabular-nums">{money(r.averageCents)}</td>
                <td className="text-right tabular-nums">{r.costCents == null ? <span className="text-ink-3">—</span> : money(r.costCents)}</td>
                <td className="pr-4">
                  {r.marginPct == null ? (
                    <span className="float-right rounded-sm border border-dashed border-warning px-1.5 text-[12px] text-warning-ink">sem custo</span>
                  ) : (
                    <span className="flex items-center justify-end gap-3">
                      <span className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-2">
                        <span className="block h-full bg-success" style={{ width: `${Math.max(0, Math.min(100, r.marginPct))}%` }} />
                      </span>
                      <strong className="w-10 text-right tabular-nums">{r.marginPct}%</strong>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="text-[12.5px] text-ink-2">
            <tr>
              <td colSpan={2} className="py-3 pl-4">
                Mostrando {shown.length} de {rows.length} · total{" "}
                {rows.length > 10 && (
                  <button type="button" className="ml-1 underline" onClick={() => setAll(!all)}>
                    {all ? "mostrar menos" : "mostrar todos"}
                  </button>
                )}
              </td>
              <td className="text-right font-semibold text-ink tabular-nums">{money(total)}</td>
              <td colSpan={3} className="pr-4 text-right">
                {marginAvg != null ? `margem média ${marginAvg}% (só com custo)` : "sem custo cadastrado"}
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </section>
  );
}
