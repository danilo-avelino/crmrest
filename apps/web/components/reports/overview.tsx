"use client";

import { CONTACT_SUBJECTS, type RatingsReportDto, RECOVERY_TAG, SERVICE_ISSUES, TEAM_REASONS, type WaitingReason } from "@dishdesk/shared";
import { ArrowRightIcon, CircleCheckIcon, InfoIcon } from "lucide-react";
import Link from "next/link";
import { count, score } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ReportPage } from "./ratings-shell";
import { BarRow, Card, Metric, plural, SectionLabel, share } from "./report-ui";
import { responseParts } from "./team";

type Ai = NonNullable<RatingsReportDto["ai"]>;

const WAITING: { reason: WaitingReason; label: string }[] = [
  { reason: "closed", label: "Restaurante fechado" },
  { reason: "full_auto", label: "100% automático ligado" },
  { reason: "offline", label: "Ninguém online" },
];

/**
 * Avaliações → Visão geral: os números do período, o que pede atenção (com o caminho para a página que detalha) e,
 * com o módulo Atendimento com IA, os assuntos, o que deu errado e quanto a IA resolveu sozinha.
 */
export function Overview() {
  return (
    <ReportPage title="Visão geral" description="Como foi o atendimento do restaurante no período">
      {(data) => <OverviewBody data={data} />}
    </ReportPage>
  );
}

function OverviewBody({ data }: { data: RatingsReportDto }) {
  const { summary, unanswered, ai } = data;
  const response = summary.averageResponseSeconds === null ? null : responseParts(summary.averageResponseSeconds);
  const afterHours = unanswered.filter((item) => item.afterHours).length;
  const clients = (
    <Metric
      label="Nota dos clientes"
      value={summary.averageScore === null ? "—" : score(summary.averageScore)}
      suffix={summary.averageScore === null ? undefined : "/ 5"}
      detail={plural(summary.ratings, "resposta à pesquisa", "respostas à pesquisa")}
    />
  );

  return (
    <>
      <div className="mb-3 grid grid-cols-4 gap-3">
        {ai ? (
          <>
            <Metric
              label="Nota dos atendimentos"
              value={ai.averageScore === null ? "—" : score(ai.averageScore)}
              suffix={ai.averageScore === null ? undefined : "/ 5"}
              detail={`${plural(ai.evaluations, "atendimento avaliado", "atendimentos avaliados")} pela IA`}
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
            {clients}
          </>
        ) : (
          <>
            {clients}
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
          </>
        )}
      </div>
      {ai && (
        <div className="mb-6 flex items-start gap-2.5 rounded-[10px] border border-dashed border-rule bg-paper/50 px-3.5 py-3 text-[12.5px] text-ink-2">
          <InfoIcon className="mt-px size-[15px] shrink-0 text-ink-3" aria-hidden />
          <span>
            A IA lê cada atendimento resolvido em que a equipe respondeu, 5 minutos depois do fim, para pegar a reação do cliente, e dá uma nota de 1 a 5.
            Os atendimentos que a IA resolveu sozinha são contados, mas não recebem nota.
          </span>
        </div>
      )}

      <SectionLabel className={cn(!ai && "mt-6")}>Precisa da sua atenção</SectionLabel>
      <Attention data={data} />

      {ai && (
        <div className="mt-6 grid grid-cols-2 items-start gap-3">
          <div>
            <SectionLabel>Assuntos dos atendimentos avaliados</SectionLabel>
            <Card>
              {ai.subjects.length === 0 ? (
                <p className="py-1.5 text-[13px] text-ink-3">Nenhum atendimento avaliado no período.</p>
              ) : (
                ai.subjects.map((item) => (
                  <BarRow key={item.subject} label={CONTACT_SUBJECTS[item.subject]} tone="ink" value={item.count} max={ai.subjects[0]!.count} text={count(item.count)} />
                ))
              )}
            </Card>
          </div>
          <div>
            <SectionLabel>O que deu errado</SectionLabel>
            <Card>
              {ai.issues.length === 0 ? (
                <p className="py-1.5 text-[13px] text-ink-3">A IA não apontou problema em nenhum atendimento do período.</p>
              ) : (
                ai.issues.map((item) => <BarRow key={item.issue} label={SERVICE_ISSUES[item.issue]} value={item.count} max={ai.issues[0]!.count} text={count(item.count)} />)
              )}
              <div className="mt-3 flex gap-6 border-t border-rule-soft pt-3 text-[12.5px] text-ink-2">
                <span className="text-ink-3">De quem foi a falha</span>
                <span>
                  <b className="text-ink tabular-nums">{count(ai.faults.atendimento)}</b> do atendimento
                </span>
                <span>
                  <b className="text-ink tabular-nums">{count(ai.faults.operacao)}</b> da cozinha ou entrega
                </span>
              </div>
            </Card>
          </div>
        </div>
      )}

      {ai && (
        <div className="mt-6 grid grid-cols-2 items-start gap-3">
          <div>
            <SectionLabel>Quem resolveu</SectionLabel>
            <WhoSolved ai={ai} />
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
      )}
    </>
  );
}

/** O que o gestor precisa olhar no período, do mais grave ao menos; cada linha leva à página que detalha. */
function Attention({ data }: { data: RatingsReportDto }) {
  const { ai, unanswered, recovering } = data;
  const unsatisfied = ai ? ai.reacted - ai.satisfied : 0;
  const items = [
    ai && {
      total: ai.misconduct.length,
      text: `${plural(ai.misconduct.length, "resposta da equipe bloqueada", "respostas da equipe bloqueadas")} por má conduta`,
      hint: "A IA achou a resposta ofensiva e não enviou ao cliente.",
      href: "/avaliacoes/equipe",
    },
    ai && {
      total: ai.lowScores,
      text: plural(ai.lowScores, "atendimento com nota baixa", "atendimentos com nota baixa"),
      hint: "Nota 1 ou 2 na avaliação da IA.",
      href: "/avaliacoes/atendimentos",
    },
    ai && {
      total: unsatisfied,
      text: plural(unsatisfied, "cliente saiu insatisfeito", "clientes saíram insatisfeitos"),
      hint: "Reclamou, se irritou ou deu nota baixa na conversa.",
      href: "/avaliacoes/atendimentos",
    },
    {
      total: recovering,
      text: plural(recovering, "cliente em recuperação", "clientes em recuperação"),
      hint: "Saíram mal de um atendimento e ainda não voltaram a pedir. Ficam com a tag até o próximo pedido.",
      href: `/clientes?tag=${encodeURIComponent(RECOVERY_TAG)}`,
    },
    {
      total: unanswered.length,
      text: `${plural(unanswered.length, "conversa ficou", "conversas ficaram")} sem resposta no fim do dia`,
      hint: "A equipe foi chamada e ninguém respondeu até a meia-noite.",
      href: "/avaliacoes/equipe",
    },
  ].filter((item) => item && item.total > 0) as { total: number; text: string; hint: string; href: string }[];

  if (items.length === 0) {
    return (
      <Card className="flex items-center gap-3">
        <CircleCheckIcon className="size-[18px] shrink-0 text-success" aria-hidden />
        <div>
          <div className="text-sm font-semibold">Nada pendente neste período</div>
          <div className="mt-0.5 text-[12.5px] text-ink-3">Sem notas baixas, clientes insatisfeitos ou conversas sem resposta.</div>
        </div>
      </Card>
    );
  }
  return (
    <ul className="overflow-hidden rounded-2xl border border-rule-soft bg-surface">
      {items.map((item) => (
        <li key={item.text} className="border-t border-rule-soft first:border-t-0">
          <Link href={item.href} className="flex items-center gap-3 px-5 py-3.5 hover:bg-paper/60">
            <span className="size-2 shrink-0 rounded-full bg-tomate" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{item.text}</span>
              <span className="mt-0.5 block text-[12.5px] text-ink-3">{item.hint}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-tomate">
              Ver
              <ArrowRightIcon className="size-3.5" aria-hidden />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Quem resolveu: só a IA ou passou pela equipe, e os motivos da passagem. */
function WhoSolved({ ai }: { ai: Ai }) {
  const toTeam = ai.withTeam;
  const total = ai.onlyAi + toTeam;
  const max = Math.max(0, ...ai.teamReasons.map((item) => item.count));
  return (
    <Card>
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-semibold">Atendimento pela IA</div>
        <div className="text-xs text-ink-3">{plural(total, "atendimento", "atendimentos")}</div>
      </div>
      <div className="mt-4 mb-2.5 flex h-3 overflow-hidden rounded-lg bg-rule">
        <div className="bg-ink" style={{ width: `${total ? (ai.onlyAi / total) * 100 : 0}%` }} />
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
