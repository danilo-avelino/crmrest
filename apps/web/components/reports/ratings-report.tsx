"use client";

import type { IfoodReviewPeriod, RatingsReportDto, ReportPeriod } from "@dishdesk/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { InfoIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TenantPicker } from "@/components/auth/tenant-picker";
import { useNow } from "@/hooks/use-now";
import { count, score } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AiEvaluations } from "./ai-evaluations";
import { IfoodReviews } from "./ifood-reviews";
import {
  AverageScore,
  BlockTitle,
  ConversationLink,
  EmptyState,
  ErrorState,
  LoadingState,
  Metric,
  Pill,
  plural,
  Row,
  ScoreBadge,
  SectionLabel,
  Table,
  when,
} from "./report-ui";

const PERIODS: { value: ReportPeriod; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
];

const IFOOD_PERIODS: { value: IfoodReviewPeriod; label: string }[] = [
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
  { value: "90d", label: "90 dias" },
];

type Tab = "team" | "ifood";

/**
 * Aba Avaliações (board "Avaliações · Atendimento · iFood · Estados"): na aba Atendimento, a avaliação da IA (módulo
 * Atendimento com IA) e a dos clientes e da equipe; na aba iFood, as avaliações das lojas. Só administradores; no
 * painel master, a barra do topo escolhe o restaurante. Desktop no MVP.
 */
export function RatingsReport() {
  const { request, session } = useAuth();
  const adminTenants = (session?.context?.tenants ?? []).filter((t) => t.role === "ADMIN");
  const [tenantId, setTenantId] = useState(() => adminTenants[0]?.id);
  const tenant = adminTenants.find((t) => t.id === tenantId) ?? adminTenants[0];
  const [tab, setTab] = useState<Tab>("team");
  const [period, setPeriod] = useState<ReportPeriod>("7d");
  const [ifoodPeriod, setIfoodPeriod] = useState<IfoodReviewPeriod>("30d");
  const now = useNow(60_000);

  const report = useQuery({
    queryKey: ["ratings-report", tenant?.id, period],
    queryFn: () => request<RatingsReportDto>(`/reports/ratings?tenantId=${tenant!.id}&period=${period}`),
    enabled: Boolean(tenant) && tab === "team",
    placeholderData: keepPreviousData,
  });
  if (!tenant) return null;
  const data = report.data;
  const hint = period === "30d" ? undefined : "Tente 30 dias para ver mais resultados.";

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-paper">
      <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-rule-soft bg-surface px-6">
        <TenantPicker tenants={adminTenants} tenant={tenant} onChange={setTenantId} />
        <span className="text-xs text-ink-3">{adminTenants.length > 1 ? `Painel master · ${plural(adminTenants.length, "restaurante", "restaurantes")}` : tenant.name}</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1380px] px-14 pt-8 pb-12">
          <div className="mb-1.5 flex items-end justify-between gap-4">
            <div>
              <h1 className="text-[21px] leading-tight font-bold">Avaliações</h1>
              <p className="mt-1 text-[13px] text-ink-3">Como os clientes e a IA avaliam o atendimento do restaurante</p>
            </div>
            {tab === "team" ? (
              <PeriodPicker options={PERIODS} value={period} onChange={setPeriod} />
            ) : (
              <PeriodPicker options={IFOOD_PERIODS} value={ifoodPeriod} onChange={setIfoodPeriod} />
            )}
          </div>
          <div role="tablist" aria-label="Avaliações" className="mt-[18px] mb-7 flex border-b border-rule-soft">
            <TabButton active={tab === "team"} onClick={() => setTab("team")}>
              Atendimento
            </TabButton>
            <TabButton active={tab === "ifood"} onClick={() => setTab("ifood")}>
              iFood
            </TabButton>
          </div>

          {tab === "ifood" ? (
            <IfoodReviews tenantId={tenant.id} period={ifoodPeriod} />
          ) : report.isPending ? (
            <LoadingState />
          ) : report.isError ? (
            <ErrorState title="Não foi possível carregar as avaliações." onRetry={() => report.refetch()} />
          ) : (
            <>
              {data!.ai && (
                <>
                  <AiEvaluations ai={data!.ai} now={now} hint={hint} />
                  <div className="mt-11 mb-9 h-px bg-rule-soft" />
                </>
              )}
              <TeamRatings data={data!} now={now} hint={hint} />
            </>
          )}
        </div>
      </div>
    </main>
  );
}

/** Avaliação dos clientes (pesquisa no WhatsApp) e os números da equipe. */
function TeamRatings({ data, now, hint }: { data: RatingsReportDto; now: number; hint?: string }) {
  const { summary, agents, unanswered, recent } = data;
  const response = summary.averageResponseSeconds === null ? null : responseParts(summary.averageResponseSeconds);
  const afterHours = unanswered.filter((item) => item.afterHours).length;
  return (
    <>
      <BlockTitle
        title="Avaliação dos clientes e da equipe"
        note="Nota da pesquisa enviada pelo WhatsApp no fim de um atendimento com pedido do dia, de 1 a 5."
      />
      <div className="mb-5 grid grid-cols-4 gap-3">
        <Metric
          label="Nota média dos clientes"
          value={summary.averageScore === null ? "—" : score(summary.averageScore)}
          suffix={summary.averageScore === null ? undefined : "/ 5"}
          detail={plural(summary.ratings, "avaliação", "avaliações")}
        />
        <Metric
          label="Tempo médio da 1ª resposta"
          value={response?.value ?? "—"}
          suffix={response?.unit}
          detail="desde que a automação chamou a equipe"
        />
        <Metric
          label="Passados à equipe"
          value={count(summary.handoffs)}
          detail={`${count(summary.handoffs - summary.answered)} ${summary.handoffs - summary.answered === 1 ? "ficou" : "ficaram"} sem resposta`}
        />
        <Metric
          label="Sem resposta no fim do dia"
          value={count(unanswered.length)}
          tone={unanswered.length ? "danger" : "ink"}
          detail={`${count(afterHours)} ${afterHours === 1 ? "chegou" : "chegaram"} fora do horário`}
        />
      </div>

      <div className="mb-5 grid grid-cols-2 items-start gap-3">
        <div>
          <SectionLabel>Por atendente</SectionLabel>
          <Table
            cols="minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)"
            head={["Atendente", "Avaliações", "Nota média", "Respondidos", "1ª resposta"]}
            empty={<EmptyState title="Nenhum atendimento neste período." hint={hint} />}
          >
            {agents.map((agent) => (
              <Row key={agent.userId ?? "none"}>
                <span className={cn(agent.userId === null && "text-ink-2")}>{agent.name}</span>
                <span className="tabular-nums">{count(agent.ratings)}</span>
                <AverageScore value={agent.averageScore} />
                <span className="tabular-nums">{count(agent.answered)}</span>
                <span className="tabular-nums">{agent.averageResponseSeconds === null ? "—" : responseShort(agent.averageResponseSeconds)}</span>
              </Row>
            ))}
          </Table>
          <div className="mt-2.5 flex items-start gap-2.5 rounded-[10px] border border-dashed border-rule bg-paper/50 px-3.5 py-3 text-[12.5px] text-ink-2">
            <InfoIcon className="mt-px size-[15px] shrink-0 text-ink-3" aria-hidden />
            <span>A nota vai para quem respondeu por último na conversa. O tempo da 1ª resposta conta para quem respondeu primeiro.</span>
          </div>
        </div>
        <div>
          <SectionLabel>Sem resposta no fim do dia</SectionLabel>
          <Table
            cols="minmax(0,1fr) 100px minmax(0,1.6fr) 100px"
            head={["Cliente", "Chamado em", "Motivo", ""]}
            empty={<EmptyState title="Nenhuma conversa ficou sem resposta." />}
          >
            {unanswered.slice(0, 50).map((item) => (
              <Row key={`${item.conversationId}-${item.calledAt}`}>
                <span className="block truncate">{item.contactName ?? "Cliente sem nome"}</span>
                <span className="whitespace-nowrap">{when(item.calledAt, now)}</span>
                {item.afterHours ? <Pill tone="neutral">Chegou fora do horário</Pill> : <Pill tone="warning">Passado à equipe pela automação</Pill>}
                <ConversationLink id={item.conversationId} />
              </Row>
            ))}
          </Table>
        </div>
      </div>

      <SectionLabel>Últimas avaliações dos clientes</SectionLabel>
      <Table
        cols="44px minmax(0,1.3fr) minmax(0,1.2fr) minmax(0,0.8fr) minmax(0,0.9fr) 100px"
        head={["Nota", "Cliente", "Atendente", "Pedido", "Quando", ""]}
        empty={<EmptyState title="Nenhuma avaliação neste período." hint={hint} />}
      >
        {recent.map((rating) => (
          <Row key={rating.id}>
            <ScoreBadge value={rating.score} />
            <b className="block truncate font-semibold">{rating.contactName ?? "Cliente sem nome"}</b>
            {rating.agentName ?? <span className="text-tomate">Sem resposta da equipe</span>}
            <span className="tabular-nums">{rating.orderCode ? `#${rating.orderCode}` : "—"}</span>
            <span className="whitespace-nowrap text-ink-2">{when(rating.createdAt, now)}</span>
            <ConversationLink id={rating.conversationId} />
          </Row>
        ))}
      </Table>
    </>
  );
}

/** Tempo da 1ª resposta no cartão: "2:40" min, "0:45" min ou "1:05" h. */
function responseParts(seconds: number): { value: string; unit: string } {
  const total = Math.round(seconds);
  if (total < 3600) return { value: `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`, unit: "min" };
  const minutes = Math.round(total / 60);
  return { value: `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`, unit: "h" };
}

/** Na tabela: "1:55" (minutos) ou "1:05 h". */
function responseShort(seconds: number): string {
  const { value, unit } = responseParts(seconds);
  return unit === "h" ? `${value} h` : value;
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "-mb-px mr-6 border-b-2 px-0.5 py-2.5 text-sm",
        active ? "border-ink font-semibold text-ink" : "border-transparent font-medium text-ink-2 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

function PeriodPicker<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="flex gap-0.5 rounded-xl bg-surface-2 p-[3px]" role="group" aria-label="Período">
      {options.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={value === item.value}
          onClick={() => onChange(item.value)}
          className={cn(
            "rounded-lg px-3.5 py-1.5 text-[12.5px] whitespace-nowrap",
            value === item.value ? "bg-surface font-semibold text-ink shadow-[0_1px_2px_rgba(26,24,20,.12)]" : "font-medium text-ink-2 hover:text-ink",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
