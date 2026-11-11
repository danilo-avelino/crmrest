"use client";

import type { RatingsReportDto } from "@dishdesk/shared";
import { AlertTriangleIcon, InfoIcon, ShieldCheckIcon } from "lucide-react";
import { count, score } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ReportPage, RestaurantName } from "./ratings-shell";
import { AiScoreBadge, Card, ConversationLink, EmptyState, Metric, Pill, plural, Row, ScoreBadge, SectionLabel, share, Table, when } from "./report-ui";

type Ai = NonNullable<RatingsReportDto["ai"]>;

/** Acima disso, a taxa de reescrita do atendente fica em âmbar. */
const REWRITE_ALERT = 0.1;

/**
 * Avaliações → Equipe: uma linha por atendente com a nota da IA, a nota dos clientes, o tempo de resposta e as
 * respostas reescritas; os alertas de má conduta e as conversas que ficaram sem resposta.
 */
export function Team() {
  return (
    <ReportPage title="Equipe" description="Como cada pessoa da equipe atende: notas, tempo de resposta e conduta">
      {(data, view) => <TeamBody data={data} {...view} />}
    </ReportPage>
  );
}

function TeamBody({ data, now, hint }: { data: RatingsReportDto; now: number; hint?: string }) {
  const { summary, agents, unanswered, ai } = data;
  const response = summary.averageResponseSeconds === null ? null : responseParts(summary.averageResponseSeconds);
  const afterHours = unanswered.filter((item) => item.afterHours).length;
  const rewritten = ai?.reviews.reduce((sum, item) => sum + item.rewritten, 0) ?? 0;
  const reviewed = ai?.reviews.reduce((sum, item) => sum + item.rewritten + item.kept, 0) ?? 0;

  // Uma linha por pessoa, juntando o que cada parte do relatório sabe dela. Sem userId: ninguém da equipe respondeu.
  const ids = [...new Set([...agents.map((item) => item.userId), ...(ai?.agents ?? []).map((item) => item.userId), ...(ai?.reviews ?? []).map((item) => item.userId)])];
  const rows = ids
    .map((userId) => {
      const team = agents.find((item) => item.userId === userId);
      const evaluated = ai?.agents.find((item) => item.userId === userId);
      const review = ai?.reviews.find((item) => item.userId === userId);
      return { userId, name: userId === null ? "Sem resposta da equipe" : (team?.name ?? evaluated?.name ?? review?.name ?? "Ex-atendente"), team, evaluated, review };
    })
    .sort((a, b) => (a.userId === null ? 1 : b.userId === null ? -1 : a.name.localeCompare(b.name, "pt-BR")));

  return (
    <>
      <div className={cn("mb-5 grid gap-3", ai ? "grid-cols-4" : "grid-cols-3")}>
        <Metric label="Tempo médio da 1ª resposta" value={response?.value ?? "—"} suffix={response?.unit} detail="desde que a automação chamou a equipe" />
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
        {ai && (
          <Metric
            label="Respostas reescritas pela IA"
            value={reviewed ? share(rewritten, reviewed) : "—"}
            detail={`${count(rewritten)} de ${plural(reviewed, "resposta revisada", "respostas revisadas")}`}
          />
        )}
      </div>

      {ai && <Misconduct alerts={ai.misconduct} now={now} />}

      <SectionLabel>Por atendente</SectionLabel>
      <Table
        cols={ai ? "minmax(0,1.4fr) repeat(5,minmax(0,1fr))" : "minmax(0,1.4fr) repeat(3,minmax(0,1fr))"}
        head={ai ? ["Atendente", "Nota da IA", "Nota dos clientes", "Respondidos", "1ª resposta", "Reescritas"] : ["Atendente", "Nota dos clientes", "Respondidos", "1ª resposta"]}
        empty={<EmptyState title="Nenhum atendimento da equipe neste período." hint={hint} />}
      >
        {rows.map(({ userId, name, team, evaluated, review }) => (
          <Row key={userId ?? "none"}>
            <span className={cn("block truncate", userId === null && "text-ink-2")}>{name}</span>
            {ai && <CountedScore value={evaluated?.averageScore ?? null} total={evaluated?.evaluations ?? 0} ai />}
            <CountedScore value={team?.averageScore ?? null} total={team?.ratings ?? 0} />
            <span className="tabular-nums">{team ? count(team.answered) : "—"}</span>
            <span className="tabular-nums">{team?.averageResponseSeconds == null ? "—" : responseShort(team.averageResponseSeconds)}</span>
            {ai &&
              (review ? (
                <Pill tone={review.rewritten / (review.rewritten + review.kept) > REWRITE_ALERT ? "warning" : "success"}>
                  {share(review.rewritten, review.rewritten + review.kept)} · {count(review.rewritten)} de {count(review.rewritten + review.kept)}
                </Pill>
              ) : (
                <span className="text-ink-3">—</span>
              ))}
          </Row>
        ))}
      </Table>
      <div className="mt-2.5 mb-5 flex items-start gap-2.5 rounded-[10px] border border-dashed border-rule bg-paper/50 px-3.5 py-3 text-[12.5px] text-ink-2">
        <InfoIcon className="mt-px size-[15px] shrink-0 text-ink-3" aria-hidden />
        <span>
          As notas vão para quem respondeu por último no atendimento; o tempo da 1ª resposta conta para quem respondeu primeiro.
          {ai && " Reescritas: respostas que a IA ajustou antes de enviar ao cliente."}
        </span>
      </div>

      {ai?.rewriteExample && (
        <>
          <SectionLabel>Última resposta reescrita</SectionLabel>
          <Card className="mb-5">
            <div className="mb-3 text-xs font-semibold text-ink-2">
              {ai.rewriteExample.agentName ?? "Ex-atendente"}, {when(ai.rewriteExample.createdAt, now).toLowerCase()}
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
        </>
      )}

      <SectionLabel>Sem resposta no fim do dia</SectionLabel>
      <Table
        cols="minmax(0,1fr) 120px minmax(0,1.2fr) 100px"
        head={["Cliente", "Chamado em", "Motivo", ""]}
        empty={<EmptyState title="Nenhuma conversa ficou sem resposta." />}
      >
        {unanswered.slice(0, 50).map((item) => (
          <Row key={`${item.conversationId}-${item.calledAt}`}>
            <span className="min-w-0">
              <span className="block truncate">{item.contactName ?? "Cliente sem nome"}</span>
              <RestaurantName tenantId={item.tenantId} />
            </span>
            <span className="whitespace-nowrap">{when(item.calledAt, now)}</span>
            {item.afterHours ? <Pill tone="neutral">Chegou fora do horário</Pill> : <Pill tone="warning">Passado à equipe pela automação</Pill>}
            <ConversationLink id={item.conversationId} />
          </Row>
        ))}
      </Table>
    </>
  );
}

/** Nota média com o número de avaliações que a formam: "4,6 · 12", ou "87% · 12" na nota da IA (`ai`). */
function CountedScore({ value, total, ai = false }: { value: number | null; total: number; ai?: boolean }) {
  if (value === null) return <span className="text-ink-3">—</span>;
  return (
    <span className="inline-flex items-center gap-2 tabular-nums">
      {ai ? (
        <AiScoreBadge value={value} />
      ) : (
        <>
          <ScoreBadge value={value} />
          {score(value)}
        </>
      )}
      <span className="text-ink-3">· {count(total)}</span>
    </span>
  );
}

/** Alertas de má conduta: o bloco mais grave da página, em tomate. Sem alertas, um aviso neutro. */
function Misconduct({ alerts, now }: { alerts: Ai["misconduct"]; now: number }) {
  if (alerts.length === 0) {
    return (
      <Card className="mb-5 flex items-center gap-3">
        <ShieldCheckIcon className="size-[18px] shrink-0 text-success" aria-hidden />
        <div>
          <div className="text-sm font-semibold">Nenhum alerta de má conduta</div>
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
          <h2 className="text-[15px] font-bold text-tomate">Alertas de má conduta</h2>
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
              <span className="block truncate">{alert.contactName ?? "Cliente sem nome"}</span>
              <RestaurantName tenantId={alert.tenantId} />
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

/** Tempo da 1ª resposta no cartão: "2:40" min, "0:45" min ou "1:05" h. */
export function responseParts(seconds: number): { value: string; unit: string } {
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
