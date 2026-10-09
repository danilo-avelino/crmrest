"use client";

import type { RatingsReportDto, ReportPeriod } from "@dishdesk/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertCircleIcon, CheckIcon, ChevronDownIcon, StarIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useNow } from "@/hooks/use-now";
import { count, dayTime, responseTime, score } from "@/lib/format";
import { cn } from "@/lib/utils";

const PERIODS: { value: ReportPeriod; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "7d", label: "Últimos 7 dias" },
  { value: "30d", label: "Últimos 30 dias" },
];

/**
 * Aba Avaliações (versão simples; o design ainda não tem este board): notas e tempo de resposta da equipe, com o
 * cabeçalho do board Clientes. Só administradores; no painel master, um seletor escolhe o restaurante. Desktop no MVP.
 */
export function RatingsReport() {
  const { request, session } = useAuth();
  const adminTenants = (session?.context?.tenants ?? []).filter((t) => t.role === "ADMIN");
  const [tenantId, setTenantId] = useState(() => adminTenants[0]?.id);
  const tenant = adminTenants.find((t) => t.id === tenantId) ?? adminTenants[0];
  const [period, setPeriod] = useState<ReportPeriod>("7d");
  const now = useNow(60_000);

  const report = useQuery({
    queryKey: ["ratings-report", tenant?.id, period],
    queryFn: () => request<RatingsReportDto>(`/reports/ratings?tenantId=${tenant!.id}&period=${period}`),
    enabled: Boolean(tenant),
    placeholderData: keepPreviousData,
  });
  if (!tenant) return null;
  const data = report.data;

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
      <header className="shrink-0 border-b border-rule-soft px-7 pt-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h1 className="mb-[3px] font-heading text-[21px] leading-tight font-bold tracking-[-0.3px]">Avaliações</h1>
            <span className="text-xs text-ink-3">{adminTenants.length > 1 ? "Painel master" : tenant.name}</span>
          </div>
          {adminTenants.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="Escolher o restaurante" className={buttonVariants({ variant: "outline", size: "sm" })}>
                {tenant.name}
                <ChevronDownIcon aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                {adminTenants.map((item) => (
                  <DropdownMenuItem key={item.id} onClick={() => setTenantId(item.id)}>
                    <span className="flex-1">{item.name}</span>
                    {item.id === tenant.id && <CheckIcon className="size-3.5" aria-hidden />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div className="flex gap-1.5 pb-3" role="group" aria-label="Período">
          {PERIODS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={period === item.value}
              onClick={() => setPeriod(item.value)}
              className={cn(
                "inline-flex h-[30px] items-center rounded-md border px-3 text-xs whitespace-nowrap",
                period === item.value ? "border-ink bg-ink text-paper" : "border-rule bg-surface text-ink-2 hover:bg-paper",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto bg-paper px-7 py-6">
        {report.isPending ? (
          <p className="text-[13px] text-ink-3" aria-busy>
            Carregando…
          </p>
        ) : report.isError ? (
          <div className="flex max-w-lg items-start gap-3 rounded-xl border border-tomate-line bg-tomate-lt p-5">
            <AlertCircleIcon className="mt-px size-[18px] shrink-0 text-tomate" aria-hidden />
            <div>
              <div className="mb-1 text-[13px] font-medium">Não foi possível carregar as avaliações</div>
              <div className="mb-2.5 text-xs text-ink-3">Verifique sua conexão e tente novamente.</div>
              <Button variant="outline" size="sm" onClick={() => report.refetch()}>
                Tentar novamente
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex max-w-[1100px] flex-col gap-6">
            <div className="grid grid-cols-4 gap-3">
              <Metric
                label="Nota média"
                value={data!.summary.averageScore === null ? "—" : score(data!.summary.averageScore)}
                detail={plural(data!.summary.ratings, "avaliação", "avaliações")}
                star={data!.summary.averageScore !== null}
              />
              <Metric
                label="Tempo médio da 1ª resposta"
                value={data!.summary.averageResponseSeconds === null ? "—" : responseTime(data!.summary.averageResponseSeconds)}
                detail={`desde que a automação chamou a equipe · ${plural(data!.summary.answered, "atendimento", "atendimentos")}`}
              />
              <Metric
                label="Atendimentos passados à equipe"
                value={count(data!.summary.handoffs)}
                detail={`${count(data!.summary.handoffs - data!.summary.answered)} sem resposta da equipe`}
              />
              <Metric
                label="Sem resposta no fim do dia"
                value={count(data!.unanswered.length)}
                detail={period === "today" ? "chamadas de hoje ainda sem resposta (até agora)" : "chamadas que terminaram o dia sem resposta"}
              />
            </div>

            <Section title="Por atendente" note="A nota vai para quem respondeu por último; o tempo, para quem deu a primeira resposta.">
              {data!.agents.length === 0 ? (
                <p className="px-5 py-6 text-[13px] text-ink-3">Nenhum atendimento no período.</p>
              ) : (
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-paper">
                      <Th>Atendente</Th>
                      <Th align="right">Avaliações</Th>
                      <Th align="right">Nota média</Th>
                      <Th align="right">Atendimentos respondidos</Th>
                      <Th align="right">Tempo médio da 1ª resposta</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data!.agents.map((agent) => (
                      <tr key={agent.userId ?? "none"} className="border-b border-rule-soft last:border-0">
                        <Td className={cn("font-medium", agent.userId === null && "font-normal text-ink-3 italic")}>{agent.name}</Td>
                        <Td align="right">{count(agent.ratings)}</Td>
                        <Td align="right">{agent.averageScore === null ? "—" : <Stars value={agent.averageScore} />}</Td>
                        <Td align="right">{count(agent.answered)}</Td>
                        <Td align="right">{agent.averageResponseSeconds === null ? "—" : responseTime(agent.averageResponseSeconds)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            <Section
              title="Sem resposta no fim do dia"
              note="Atendimentos passados à equipe (ou recebidos fora do horário) em que ninguém da equipe respondeu até 23:59."
            >
              {data!.unanswered.length === 0 ? (
                <p className="px-5 py-6 text-[13px] text-ink-3">Nenhuma conversa ficou sem resposta no período.</p>
              ) : (
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-paper">
                      <Th>Cliente</Th>
                      <Th>Chamado em</Th>
                      <Th>Motivo</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {data!.unanswered.slice(0, 50).map((item) => (
                      <tr key={`${item.conversationId}-${item.calledAt}`} className="border-b border-rule-soft last:border-0">
                        <Td className="font-medium">{item.contactName ?? "Cliente sem nome"}</Td>
                        <Td className="text-ink-3">{dayTime(item.calledAt, now)}</Td>
                        <Td>{item.afterHours ? "Chegou fora do horário" : "Passado à equipe pela automação"}</Td>
                        <Td align="right">
                          <Link href={`/inbox?conversa=${item.conversationId}`} className="text-xs text-tomate underline underline-offset-2">
                            Ver conversa
                          </Link>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            <Section title="Últimas avaliações">
              {data!.recent.length === 0 ? (
                <p className="px-5 py-6 text-[13px] text-ink-3">Nenhuma avaliação no período.</p>
              ) : (
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-paper">
                      <Th>Nota</Th>
                      <Th>Cliente</Th>
                      <Th>Atendente</Th>
                      <Th>Pedido</Th>
                      <Th>Quando</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {data!.recent.map((rating) => (
                      <tr key={rating.id} className="border-b border-rule-soft last:border-0">
                        <Td>
                          <Stars value={rating.score} />
                        </Td>
                        <Td className="font-medium">{rating.contactName ?? "Cliente sem nome"}</Td>
                        <Td className={cn(!rating.agentName && "text-ink-3 italic")}>{rating.agentName ?? "Sem resposta da equipe"}</Td>
                        <Td>{rating.orderCode ? `#${rating.orderCode}` : "—"}</Td>
                        <Td className="text-ink-3">{dayTime(rating.createdAt, now)}</Td>
                        <Td align="right">
                          <Link href={`/inbox?conversa=${rating.conversationId}`} className="text-xs text-tomate underline underline-offset-2">
                            Ver conversa
                          </Link>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          </div>
        )}
      </div>
    </main>
  );
}

function plural(value: number, one: string, many: string): string {
  return `${count(value)} ${value === 1 ? one : many}`;
}

function Metric({ label, value, detail, star }: { label: string; value: string; detail: string; star?: boolean }) {
  return (
    <div className="rounded-xl border border-rule bg-surface px-5 py-4">
      <div className="mb-2 text-[11px] font-medium tracking-[0.05em] text-ink-3 uppercase">{label}</div>
      <div className="flex items-center gap-1.5 font-heading text-[28px] leading-none font-bold tracking-[-0.5px] tabular-nums">
        {value}
        {star && <StarIcon className="size-5 fill-warning text-warning" aria-hidden />}
      </div>
      <div className="mt-2 text-xs text-ink-3">{detail}</div>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-rule bg-surface">
      <div className="border-b border-rule-soft px-5 py-3.5">
        <h2 className="font-heading text-title font-semibold">{title}</h2>
        {note && <p className="mt-0.5 text-xs text-ink-3">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-1 tabular-nums" aria-label={`Nota ${score(value)} de 5`}>
      <StarIcon className="size-3.5 fill-warning text-warning" aria-hidden />
      {Number.isInteger(value) ? value : score(value)}
    </span>
  );
}

function Th({ children, align = "left" }: { children?: ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={cn(
        "border-b border-rule-soft px-3 py-2.5 text-[11px] font-medium tracking-[0.05em] whitespace-nowrap text-ink-3 uppercase first:pl-5 last:pr-5",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className, align = "left" }: { children?: ReactNode; className?: string; align?: "left" | "right" }) {
  return (
    <td className={cn("px-3 py-2.5 text-[13px] tabular-nums first:pl-5 last:pr-5", align === "right" && "text-right", className)}>
      {children}
    </td>
  );
}
