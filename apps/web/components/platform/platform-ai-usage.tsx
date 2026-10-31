"use client";

import type { PlatformAiUsageDto } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { PlatformHeader, PlatformLoading } from "@/components/platform/platform-header";
import { Button } from "@/components/ui/button";
import { count } from "@/lib/format";

// Centavos de dólar somem numa chamada só: até quatro casas.
const usdFormat = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const monthFormat = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });

/** O mês de agora no horário de Brasília: "2026-10". */
function currentMonth(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, number - 1 + delta, 1)).toISOString().slice(0, 7);
}

/** Gastos com o Claude (a reserva do Atendimento com IA) por mês: o total e os restaurantes que mais consumiram. */
export function PlatformAiUsage() {
  const { request } = useAuth();
  const [month, setMonth] = useState(currentMonth);
  const usage = useQuery({
    queryKey: ["platform-ai-usage", month],
    queryFn: () => request<PlatformAiUsageDto>(`/platform/ai-usage?month=${month}`),
  });
  const data = usage.data;
  const top = Math.max(Number.EPSILON, ...(data?.tenants.map((tenant) => tenant.costUsd) ?? []));
  const label = monthFormat.format(new Date(`${month}-01T00:00:00Z`));

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
      <PlatformHeader title="Gastos com IA" />
      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="flex max-w-[760px] flex-col gap-5">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" aria-label="Mês anterior" onClick={() => setMonth(shiftMonth(month, -1))}>
              <ChevronLeftIcon aria-hidden />
            </Button>
            <span className="w-40 text-center font-medium capitalize">{label}</span>
            <Button
              variant="outline"
              size="sm"
              aria-label="Próximo mês"
              disabled={month >= currentMonth()}
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              <ChevronRightIcon aria-hidden />
            </Button>
          </div>

          {data ? (
            <>
              <section className="grid grid-cols-2 overflow-hidden rounded-xl border border-rule">
                <div className="border-r border-rule px-5 py-4">
                  <p className="text-ink-3">Total gasto no mês</p>
                  <p className="mt-1 font-heading text-display font-bold tracking-[-0.5px] tabular-nums">{usdFormat.format(data.costUsd)}</p>
                </div>
                <div className="px-5 py-4">
                  <p className="text-ink-3">Chamadas ao Claude</p>
                  <p className="mt-1 font-heading text-display font-bold tracking-[-0.5px] tabular-nums">{count(data.calls)}</p>
                </div>
              </section>

              <section className="overflow-hidden rounded-xl border border-rule">
                <div className="border-b border-rule px-5 pt-4 pb-3.5">
                  <h2 className="font-heading text-title font-semibold">Restaurantes que mais consumiram</h2>
                  <p className="mt-1 text-ink-2">
                    O Claude só é chamado quando a LLM local está fora do ar. O custo é calculado pelo preço do modelo na hora de cada
                    chamada, em dólares.
                  </p>
                </div>
                {data.tenants.length === 0 ? (
                  <p className="px-5 py-6 text-ink-3">Nenhum gasto com o Claude neste mês.</p>
                ) : (
                  <ol>
                    {data.tenants.map((tenant, index) => (
                      <li key={tenant.tenantId} className="flex items-center gap-3 border-b border-rule-soft px-5 py-3 last:border-b-0">
                        <span className="w-6 shrink-0 text-[12px] text-ink-3 tabular-nums">{index + 1}º</span>
                        <span className="w-48 shrink-0 truncate font-medium">{tenant.tenantName}</span>
                        <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
                          <span className="block h-full rounded-full bg-tomate" style={{ width: `${(tenant.costUsd / top) * 100}%` }} />
                        </span>
                        <span
                          className="w-36 shrink-0 text-right text-[12px] text-ink-3 tabular-nums"
                          title={`${count(tenant.inputTokens)} tokens de entrada · ${count(tenant.outputTokens)} de saída`}
                        >
                          {count(tenant.calls)} {tenant.calls === 1 ? "chamada" : "chamadas"} · {count(tenant.inputTokens + tenant.outputTokens)} tokens
                        </span>
                        <span className="w-24 shrink-0 text-right font-medium tabular-nums">{usdFormat.format(tenant.costUsd)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          ) : (
            <PlatformLoading failed={usage.isError} />
          )}
        </div>
      </div>
    </main>
  );
}
