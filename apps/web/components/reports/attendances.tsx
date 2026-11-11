"use client";

import { CHURN_RISK_ALERT, CONTACT_SUBJECTS, LOW_AI_SCORE, type RatingsReportDto, SERVICE_FAULTS, SERVICE_ISSUES } from "@dishdesk/shared";
import { CheckIcon, ChevronDownIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { count } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ReportPage, RestaurantName } from "./ratings-shell";
import { AiScoreBadge, Card, Chip, ConversationLink, EmptyState, percent, Pill, Row, Table, when } from "./report-ui";

type Ai = NonNullable<RatingsReportDto["ai"]>;
type Filter = "all" | "low" | "unresolved" | "unsatisfied" | "risk";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "low", label: "Notas baixas" },
  { value: "unresolved", label: "Não resolvidos" },
  { value: "unsatisfied", label: "Insatisfeitos" },
  { value: "risk", label: "Risco de perder" },
];

/**
 * Avaliações → Atendimentos: cada atendimento que a IA avaliou (módulo Atendimento com IA), com filtros: a nota, o
 * assunto, o que deu errado (e de quem foi a falha), se foi resolvido, a reação e o risco de perder o cliente.
 */
export function Attendances() {
  return (
    <ReportPage title="Atendimentos" description="Cada atendimento avaliado pela IA: a nota, o assunto, o que deu errado e o risco de perder o cliente">
      {(data, { now, hint }) =>
        data.ai ? (
          <Evaluations ai={data.ai} now={now} hint={hint} />
        ) : (
          <Card className="flex max-w-xl items-start gap-3">
            <SparklesIcon className="mt-0.5 size-[18px] shrink-0 text-ink-3" aria-hidden />
            <div>
              <div className="text-sm font-semibold">Disponível no módulo Atendimento com IA</div>
              <div className="mt-0.5 text-[12.5px] leading-normal text-ink-3">
                Com o módulo, a IA lê cada atendimento resolvido e diz se o problema foi resolvido, como o cliente reagiu e que nota o atendimento merece.
              </div>
            </div>
          </Card>
        )
      }
    </ReportPage>
  );
}

function Evaluations({ ai, now, hint }: { ai: Ai; now: number; hint?: string }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [agent, setAgent] = useState<string | null | undefined>(undefined); // undefined = todos; null = só a IA
  const agentName = agent === undefined ? "todos" : (ai.agents.find((item) => item.userId === agent)?.name ?? "todos");
  const shown = ai.recent.filter(
    (evaluation) =>
      (agent === undefined || evaluation.userId === agent) &&
      (filter === "all" ||
        (filter === "low" && evaluation.score <= LOW_AI_SCORE) ||
        (filter === "unresolved" && !evaluation.resolved) ||
        (filter === "unsatisfied" && evaluation.satisfied === false) ||
        (filter === "risk" && (evaluation.churnRisk ?? 0) >= CHURN_RISK_ALERT)),
  );

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        {FILTERS.map((item) => (
          <Chip key={item.value} active={filter === item.value} onClick={() => setFilter(item.value)}>
            {item.label}
          </Chip>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[12.5px] whitespace-nowrap",
              agent === undefined ? "border-rule-soft bg-surface font-medium text-ink-2 hover:bg-paper" : "border-ink bg-ink font-semibold text-surface",
            )}
          >
            Atendente: {agentName}
            <ChevronDownIcon className="size-3" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56">
            {[{ userId: undefined, name: "Todos" }, ...ai.agents].map((item) => (
              <DropdownMenuItem key={item.userId ?? String(item.userId)} onClick={() => setAgent(item.userId)}>
                <span className="flex-1">{item.name}</span>
                {item.userId === agent && <CheckIcon className="size-3.5" aria-hidden />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex-1" />
        <span className="text-xs text-ink-3 tabular-nums">
          Mostrando {count(shown.length)} de {count(ai.recent.length)}
        </span>
      </div>
      <Table
        cols="52px minmax(0,1.1fr) minmax(0,1.1fr) minmax(0,1.2fr) minmax(0,1fr) 76px 96px 56px 100px"
        head={["Nota", "Cliente", "Assunto", "O que deu errado", "Quem atendeu", "Resolvido", "Reação", "Risco", ""]}
        empty={
          <EmptyState
            title={ai.recent.length ? "Nenhum atendimento com esse filtro." : "Nenhum atendimento avaliado neste período."}
            hint={ai.recent.length ? undefined : hint}
          />
        }
      >
        {shown.map((evaluation) => (
          <Row key={evaluation.id}>
            <AiScoreBadge value={evaluation.score} />
            <span>
              <b className="block truncate font-semibold">{evaluation.contactName ?? "Cliente sem nome"}</b>
              <span className="block text-xs whitespace-nowrap text-ink-3">{when(evaluation.createdAt, now)}</span>
              <RestaurantName tenantId={evaluation.tenantId} />
            </span>
            <span className="text-ink-2">{evaluation.subject ? CONTACT_SUBJECTS[evaluation.subject] : "—"}</span>
            {evaluation.issue || evaluation.fault ? (
              <span>
                {evaluation.issue && <span className="block">{SERVICE_ISSUES[evaluation.issue]}</span>}
                {evaluation.fault && <span className="block text-xs text-ink-3">Falha: {SERVICE_FAULTS[evaluation.fault].toLowerCase()}</span>}
              </span>
            ) : (
              <span className="text-ink-3">—</span>
            )}
            {evaluation.agentName ?? <span className="text-ink-2">Só a IA atendeu</span>}
            {evaluation.resolved ? <Pill tone="success">Sim</Pill> : <Pill tone="danger">Não</Pill>}
            {evaluation.satisfied === null ? (
              <Pill tone="neutral">Sem reação</Pill>
            ) : evaluation.satisfied ? (
              <Pill tone="success">Satisfeito</Pill>
            ) : (
              <Pill tone="danger">Insatisfeito</Pill>
            )}
            {evaluation.churnRisk === null ? (
              <span className="text-ink-3">—</span>
            ) : (
              <span className={evaluation.churnRisk >= CHURN_RISK_ALERT ? "font-semibold text-tomate tabular-nums" : "text-ink-2 tabular-nums"}>{percent(evaluation.churnRisk)}</span>
            )}
            <ConversationLink id={evaluation.conversationId} />
          </Row>
        ))}
      </Table>
    </>
  );
}
