"use client";

import { type RatingsReportDto, TEAM_REASONS, type WaitingReason } from "@dishdesk/shared";
import { AlertTriangleIcon, CheckIcon, ChevronDownIcon, ShieldCheckIcon } from "lucide-react";
import { useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { count, score } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  AverageScore,
  BarRow,
  BlockTitle,
  Card,
  Chip,
  ConversationLink,
  EmptyState,
  Metric,
  Pill,
  plural,
  Row,
  ScoreBadge,
  SectionLabel,
  share,
  Table,
  when,
} from "./report-ui";

type Ai = NonNullable<RatingsReportDto["ai"]>;
type Filter = "all" | "low" | "unresolved" | "unsatisfied";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Todas" },
  { value: "low", label: "Notas baixas" },
  { value: "unresolved", label: "Não resolvidos" },
  { value: "unsatisfied", label: "Insatisfeitos" },
];

const WAITING: { reason: WaitingReason; label: string }[] = [
  { reason: "closed", label: "Restaurante fechado" },
  { reason: "full_auto", label: "100% automático ligado" },
  { reason: "offline", label: "Ninguém online" },
];

/** Acima disso, a taxa de reescrita do atendente fica em âmbar. */
const REWRITE_ALERT = 0.1;

/**
 * Avaliação da IA (módulo Atendimento com IA), no topo da aba Atendimento: números, alertas de má conduta, avaliação
 * por atendente, quem resolveu, revisão automática das respostas, fila sem atendente e as últimas avaliações.
 */
export function AiEvaluations({ ai, now, hint }: { ai: Ai; now: number; hint?: string }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [agent, setAgent] = useState<string | null | undefined>(undefined); // undefined = todos; null = só a IA
  const agentName = agent === undefined ? "todos" : (ai.agents.find((item) => item.userId === agent)?.name ?? "todos");
  const shown = ai.recent.filter(
    (evaluation) =>
      (agent === undefined || evaluation.userId === agent) &&
      (filter === "all" ||
        (filter === "low" && evaluation.score <= 2) ||
        (filter === "unresolved" && !evaluation.resolved) ||
        (filter === "unsatisfied" && evaluation.satisfied === false)),
  );

  return (
    <>
      <BlockTitle
        title="Avaliação da IA"
        badge="Atendimento com IA"
        note="A IA lê cada atendimento resolvido 5 minutos depois do fim, para pegar a reação do cliente, e dá uma nota."
      />
      <div className="mb-5 grid grid-cols-4 gap-3">
        <Metric
          label="Nota média da IA"
          value={ai.averageScore === null ? "—" : score(ai.averageScore)}
          suffix={ai.averageScore === null ? undefined : "/ 5"}
          detail={`em ${plural(ai.evaluations, "atendimento avaliado", "atendimentos avaliados")}`}
        />
        <Metric
          label="Problemas resolvidos"
          value={ai.evaluations ? share(ai.resolved, ai.evaluations) : "—"}
          tone={ai.evaluations ? "success" : "ink"}
          detail={`${count(ai.resolved)} de ${plural(ai.evaluations, "atendimento", "atendimentos")}`}
        />
        <Metric
          label="Clientes satisfeitos"
          value={ai.reacted ? share(ai.satisfied, ai.reacted) : "—"}
          tone={ai.reacted ? "success" : "ink"}
          detail={ai.reacted ? `entre ${ai.reacted === 1 ? "o 1 que reagiu" : `os ${count(ai.reacted)} que reagiram`}` : "nenhum cliente reagiu"}
        />
        <Metric
          label="Notas baixas (1 ou 2)"
          value={count(ai.lowScores)}
          tone={ai.lowScores ? "danger" : "ink"}
          detail={ai.evaluations ? `${share(ai.lowScores, ai.evaluations)} dos atendimentos avaliados` : "nenhum atendimento avaliado"}
        />
      </div>

      <Misconduct alerts={ai.misconduct} now={now} />

      <div className="mb-5 grid grid-cols-2 items-start gap-3">
        <div>
          <SectionLabel>Avaliação da IA por atendente</SectionLabel>
          <Table
            cols="minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr)"
            head={["Atendente", "Avaliados", "Nota média"]}
            empty={<EmptyState title="Nenhum atendimento avaliado neste período." hint={hint} />}
          >
            {ai.agents.map((item) => (
              <Row key={item.userId ?? "ai"}>
                <span className={cn(item.userId === null && "text-ink-2")}>{item.name}</span>
                <span className="tabular-nums">{count(item.evaluations)}</span>
                <AverageScore value={item.averageScore} />
              </Row>
            ))}
          </Table>
        </div>
        <div>
          <SectionLabel>Quem resolveu</SectionLabel>
          <WhoSolved ai={ai} />
        </div>
      </div>

      <div className="mb-5 grid grid-cols-2 items-start gap-3">
        <div>
          <SectionLabel>Revisão automática das respostas</SectionLabel>
          <Table
            cols="minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)"
            head={["Atendente", "Reescritas", "Mantidas", "Reescrita"]}
            empty={<EmptyState title="Nenhuma resposta da equipe revisada neste período." />}
          >
            {ai.reviews.map((item) => {
              const rate = item.rewritten / (item.rewritten + item.kept);
              return (
                <Row key={item.userId}>
                  {item.name}
                  <span className="tabular-nums">{count(item.rewritten)}</span>
                  <span className="tabular-nums">{count(item.kept)}</span>
                  <Pill tone={rate > REWRITE_ALERT ? "warning" : "success"}>{share(item.rewritten, item.rewritten + item.kept)}</Pill>
                </Row>
              );
            })}
          </Table>
          {ai.rewriteExample && (
            <Card className="mt-3">
              <div className="mb-3 text-xs font-semibold text-ink-2">
                Exemplo · {ai.rewriteExample.agentName ?? "Ex-atendente"}, {when(ai.rewriteExample.createdAt, now).toLowerCase()}
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-[10px] bg-paper px-3.5 py-3">
                  <div className="mb-1.5 text-[11px] font-bold text-ink-3">Antes</div>
                  <div className="text-[13px] whitespace-pre-wrap text-ink-2 line-through decoration-rule">{ai.rewriteExample.original}</div>
                </div>
                <div className="rounded-[10px] bg-success-lt px-3.5 py-3">
                  <div className="mb-1.5 text-[11px] font-bold text-success">Enviada</div>
                  <div className="text-[13px] whitespace-pre-wrap">{ai.rewriteExample.text}</div>
                </div>
              </div>
            </Card>
          )}
        </div>
        <div>
          <SectionLabel>Fila sem atendente</SectionLabel>
          <Card>
            <div className="text-sm font-semibold">Conversas que esperaram atendente</div>
            <div className="mt-[3px] text-[12.5px] text-ink-3">A IA precisou da equipe, mas ninguém pôde assumir na hora.</div>
            <div className="mt-4 grid grid-cols-3 gap-2.5">
              {WAITING.map((item) => (
                <div key={item.reason} className="rounded-[10px] bg-paper p-3.5">
                  <div className="font-heading text-[28px] leading-none font-semibold tabular-nums">{count(ai.waiting[item.reason])}</div>
                  <div className="mt-1.5 text-[12.5px] text-ink-2">{item.label}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <SectionLabel className="mt-1">Últimas avaliações da IA</SectionLabel>
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
        cols="44px 120px minmax(0,2.4fr) 120px 76px 96px 92px 100px"
        head={["Nota", "Cliente", "Resumo da IA", "Quem atendeu", "Resolvido", "Reação", "Quando", ""]}
        empty={<EmptyState title={ai.recent.length ? "Nenhuma avaliação com esse filtro." : "Nenhum atendimento avaliado neste período."} hint={ai.recent.length ? undefined : hint} />}
      >
        {shown.map((evaluation) => (
          <Row key={evaluation.id}>
            <ScoreBadge value={evaluation.score} />
            <b className="block truncate font-semibold">{evaluation.contactName ?? "Cliente sem nome"}</b>
            <span className="text-ink-2">{evaluation.summary}</span>
            {evaluation.agentName ?? <span className="text-ink-2">Só a IA atendeu</span>}
            {evaluation.resolved ? <Pill tone="success">Sim</Pill> : <Pill tone="danger">Não</Pill>}
            {evaluation.satisfied === null ? (
              <Pill tone="neutral">Sem reação</Pill>
            ) : evaluation.satisfied ? (
              <Pill tone="success">Satisfeito</Pill>
            ) : (
              <Pill tone="danger">Insatisfeito</Pill>
            )}
            <span className="whitespace-nowrap text-ink-2">{when(evaluation.createdAt, now)}</span>
            <ConversationLink id={evaluation.conversationId} />
          </Row>
        ))}
      </Table>
    </>
  );
}

/** Alertas de má conduta: o bloco mais grave da aba, em tomate. Sem alertas, um aviso neutro. */
function Misconduct({ alerts, now }: { alerts: Ai["misconduct"]; now: number }) {
  if (alerts.length === 0) {
    return (
      <Card className="mb-5 flex items-center gap-3">
        <ShieldCheckIcon className="size-[18px] shrink-0 text-success" aria-hidden />
        <div>
          <div className="text-[15px] font-bold">Alertas de má conduta</div>
          <div className="mt-0.5 text-[12.5px] text-ink-3">Nenhuma resposta da equipe foi bloqueada pela IA neste período.</div>
        </div>
      </Card>
    );
  }
  const cols = "110px 130px minmax(0,1.4fr) minmax(0,1fr) 100px 100px";
  return (
    <section
      className="mb-5 overflow-hidden rounded-2xl border border-l-4 border-tomate-line border-l-tomate bg-surface shadow-[0_6px_20px_-10px_rgba(196,52,26,.35)]"
      aria-label="Alertas de má conduta"
    >
      <div className="flex items-center gap-3 bg-tomate-lt px-5 py-4">
        <AlertTriangleIcon className="size-[18px] shrink-0 text-tomate" aria-hidden />
        <div className="flex-1">
          <h3 className="text-[15px] font-bold text-tomate">Alertas de má conduta</h3>
          <p className="mt-0.5 text-[12.5px] text-tomate-ink">Respostas da equipe que a IA achou ofensivas e não enviou ao cliente.</p>
        </div>
        <span className="font-heading text-[28px] font-semibold text-tomate tabular-nums">{count(alerts.length)}</span>
      </div>
      <div role="table">
        <div role="row" className="grid gap-4 bg-tomate-lt/40 px-5 py-2.5" style={{ gridTemplateColumns: cols }}>
          {["Atendente", "Cliente", "Mensagem original", "Motivo da IA", "Quando", ""].map((title, index) => (
            <div key={index} role="columnheader" className="text-[10.5px] font-bold tracking-[0.07em] text-tomate-ink/60 uppercase">
              {title}
            </div>
          ))}
        </div>
        {alerts.map((alert) => (
          <div key={alert.messageId} role="row" className="grid items-start gap-4 border-t border-tomate-line/50 px-5 py-3.5 text-[13px]" style={{ gridTemplateColumns: cols }}>
            <div role="cell" className="font-semibold">
              {alert.agentName ?? "Ex-atendente"}
            </div>
            <div role="cell" className="min-w-0 truncate">
              {alert.contactName ?? "Cliente sem nome"}
            </div>
            <div role="cell" className="font-heading text-sm whitespace-pre-wrap">
              “{alert.original}”
            </div>
            <div role="cell" className="text-ink-2">
              {alert.reason}
            </div>
            <div role="cell" className="text-ink-2">
              {when(alert.createdAt, now)}
            </div>
            <div role="cell">
              <ConversationLink id={alert.conversationId} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Quem resolveu: só a IA ou passou pela equipe, e os motivos da passagem. */
function WhoSolved({ ai }: { ai: Ai }) {
  const toTeam = ai.evaluations - ai.onlyAi;
  const max = Math.max(0, ...ai.teamReasons.map((item) => item.count));
  return (
    <Card>
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-semibold">Atendimento pela IA</div>
        <div className="text-xs text-ink-3">{plural(ai.evaluations, "atendimento", "atendimentos")}</div>
      </div>
      <div className="mt-4 mb-2.5 flex h-3 overflow-hidden rounded-lg bg-rule">
        <div className="bg-ink" style={{ width: `${ai.evaluations ? (ai.onlyAi / ai.evaluations) * 100 : 0}%` }} />
      </div>
      <div className="mb-[18px] flex gap-6 text-[12.5px] text-ink-2">
        <span>
          <b className="text-ink tabular-nums">{count(ai.onlyAi)}</b> {ai.onlyAi === 1 ? "resolvido" : "resolvidos"} só pela IA
        </span>
        <span>
          <b className="text-ink tabular-nums">{count(toTeam)}</b> {toTeam === 1 ? "passado" : "passados"} à equipe
        </span>
      </div>
      <div className="mb-1 text-xs font-semibold text-ink-2">Motivos da passagem para a equipe</div>
      {ai.teamReasons.length === 0 ? (
        <p className="py-1.5 text-[13px] text-ink-3">Nenhum motivo registrado no período.</p>
      ) : (
        ai.teamReasons.map((item) => <BarRow key={item.reason} label={TEAM_REASONS[item.reason]} value={item.count} max={max} text={count(item.count)} />)
      )}
    </Card>
  );
}
