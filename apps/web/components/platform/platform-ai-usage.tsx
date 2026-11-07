"use client";

import { AI_USAGE_PROVIDER_LABEL, type AiUsageProvider, type AiUsageTotals, type PlatformAiUsageDto } from "@dishdesk/shared";
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

const PROVIDERS: AiUsageProvider[] = ["CLAUDE", "JEV", "LOCAL"];

const tokens = (totals: AiUsageTotals) => totals.inputTokens + totals.outputTokens;
const calls = (value: number) => `${count(value)} ${value === 1 ? "chamada" : "chamadas"}`;

/** O que cada provedor usou: o custo do Claude e do Jev; da IA local, que não custa nada, os tokens. */
function providerUsage(provider: AiUsageProvider, totals: AiUsageTotals): string {
  return `${AI_USAGE_PROVIDER_LABEL[provider]} ${provider === "LOCAL" ? `${count(tokens(totals))} tokens` : usdFormat.format(totals.costUsd)}`;
}

/** Uso de IA por mês: o Claude, o Jev e a IA local, no total e nos restaurantes que mais consumiram. */
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
        <div className="flex max-w-[880px] flex-col gap-5">
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
              <section className="grid grid-cols-4 overflow-hidden rounded-xl border border-rule">
                <div className="border-r border-rule px-5 py-4">
                  <p className="text-ink-3">Total gasto no mês</p>
                  <p className="mt-1 font-heading text-display font-bold tracking-[-0.5px] tabular-nums">{usdFormat.format(data.costUsd)}</p>
                  <p className="mt-1 text-[12px] text-ink-3 tabular-nums">{calls(data.calls)}</p>
                </div>
                {PROVIDERS.map((provider) => {
                  const totals = data.providers[provider];
                  return (
                    <div key={provider} className="border-r border-rule px-5 py-4 last:border-r-0">
                      <p className="text-ink-3">{AI_USAGE_PROVIDER_LABEL[provider]}</p>
                      <p className="mt-1 font-heading text-display font-bold tracking-[-0.5px] tabular-nums">
                        {provider === "LOCAL" ? count(tokens(totals)) : usdFormat.format(totals.costUsd)}
                      </p>
                      <p className="mt-1 text-[12px] text-ink-3 tabular-nums">
                        {calls(totals.calls)} · {provider === "LOCAL" ? "tokens, sem custo" : `${count(tokens(totals))} tokens`}
                      </p>
                    </div>
                  );
                })}
              </section>

              <section className="overflow-hidden rounded-xl border border-rule">
                <div className="border-b border-rule px-5 pt-4 pb-3.5">
                  <h2 className="font-heading text-title font-semibold">Restaurantes que mais consumiram</h2>
                  <p className="mt-1 text-ink-2">
                    O Claude só é chamado quando a IA local está fora do ar; o custo dele é o preço do modelo na hora de cada chamada.
                    O Jev avalia os atendimentos e analisa os casos da defesa da API (a linha da plataforma); o custo dele é o que o
                    OpenRouter cobrou. A IA local não tem custo: só os tokens. Valores em dólares.
                  </p>
                </div>
                {data.tenants.length === 0 ? (
                  <p className="px-5 py-6 text-ink-3">Nenhum uso de IA neste mês.</p>
                ) : (
                  <ol>
                    {data.tenants.map((tenant, index) => (
                      <li key={tenant.tenantId ?? "plataforma"} className="border-b border-rule-soft px-5 py-3 last:border-b-0">
                        <div className="flex items-center gap-3">
                          <span className="w-6 shrink-0 text-[12px] text-ink-3 tabular-nums">{index + 1}º</span>
                          <span className="w-48 shrink-0 truncate font-medium">{tenant.tenantName}</span>
                          <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
                            <span className="block h-full rounded-full bg-tomate" style={{ width: `${(tenant.costUsd / top) * 100}%` }} />
                          </span>
                          <span
                            className="w-36 shrink-0 text-right text-[12px] text-ink-3 tabular-nums"
                            title={`${count(tenant.inputTokens)} tokens de entrada · ${count(tenant.outputTokens)} de saída`}
                          >
                            {calls(tenant.calls)} · {count(tokens(tenant))} tokens
                          </span>
                          <span className="w-24 shrink-0 text-right font-medium tabular-nums">{usdFormat.format(tenant.costUsd)}</span>
                        </div>
                        <p className="mt-1 pl-9 text-[12px] text-ink-3 tabular-nums">
                          {PROVIDERS.flatMap((provider) => {
                            const totals = tenant.providers[provider];
                            return totals ? [providerUsage(provider, totals)] : [];
                          }).join(" · ")}
                        </p>
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
