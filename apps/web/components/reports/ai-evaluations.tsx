"use client";

import type { RatingsReportDto } from "@dishdesk/shared";
import Link from "next/link";
import { count, dayTime, percent, score } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Metric, plural, Section, Stars, Td, Th } from "./ratings-report";

/**
 * Avaliações dos atendimentos pela IA (módulo Atendimento com IA), na aba Atendimento das Avaliações. Sem board no
 * design: segue os blocos da própria aba (métricas, tabelas).
 */
export function AiEvaluations({ ai, now }: { ai: NonNullable<RatingsReportDto["ai"]>; now: number }) {
  return (
    <>
      <div>
        <h2 className="mb-0.5 font-heading text-title font-semibold">Avaliação da IA</h2>
        <p className="text-xs text-ink-3">A IA lê cada atendimento resolvido e avalia a solução e a reação do cliente.</p>
      </div>
      <div className="grid grid-cols-4 gap-3">
        <Metric
          label="Nota média da IA"
          value={ai.averageScore === null ? "—" : score(ai.averageScore)}
          detail={plural(ai.evaluations, "atendimento avaliado", "atendimentos avaliados")}
          star={ai.averageScore !== null}
        />
        <Metric
          label="Problema resolvido"
          value={ai.resolvedRate === null ? "—" : percent(ai.resolvedRate)}
          detail="dos atendimentos avaliados"
        />
        <Metric
          label="Cliente satisfeito"
          value={ai.satisfiedRate === null ? "—" : percent(ai.satisfiedRate)}
          detail="entre os clientes que reagiram"
        />
        <Metric
          label="Notas baixas"
          value={count(ai.recent.filter((evaluation) => evaluation.score <= 2).length)}
          detail="nota 1 ou 2 nas últimas avaliações"
        />
      </div>

      <Section title="Avaliação da IA por atendente" note="A avaliação vai para quem da equipe respondeu por último no atendimento.">
        {ai.agents.length === 0 ? (
          <p className="px-5 py-6 text-[13px] text-ink-3">Nenhum atendimento avaliado no período.</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-paper">
                <Th>Atendente</Th>
                <Th align="right">Atendimentos avaliados</Th>
                <Th align="right">Nota média</Th>
              </tr>
            </thead>
            <tbody>
              {ai.agents.map((agent) => (
                <tr key={agent.userId ?? "ai"} className="border-b border-rule-soft last:border-0">
                  <Td className={cn("font-medium", agent.userId === null && "font-normal text-ink-3 italic")}>{agent.name}</Td>
                  <Td align="right">{count(agent.evaluations)}</Td>
                  <Td align="right">{agent.averageScore === null ? "—" : <Stars value={agent.averageScore} />}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Últimas avaliações da IA">
        {ai.recent.length === 0 ? (
          <p className="px-5 py-6 text-[13px] text-ink-3">Nenhum atendimento avaliado no período.</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-paper">
                <Th>Nota</Th>
                <Th>Cliente</Th>
                <Th>Resumo</Th>
                <Th>Resolvido</Th>
                <Th>Reação</Th>
                <Th>Quando</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {ai.recent.map((evaluation) => (
                <tr key={evaluation.id} className="border-b border-rule-soft align-top last:border-0">
                  <Td>
                    <Stars value={evaluation.score} />
                  </Td>
                  <Td className="font-medium whitespace-nowrap">{evaluation.contactName ?? "Cliente sem nome"}</Td>
                  <Td className="max-w-[420px] text-ink-2">
                    {evaluation.summary}
                    <div className={cn("mt-0.5 text-xs text-ink-3", !evaluation.agentName && "italic")}>
                      {evaluation.agentName ?? "Só a IA atendeu"}
                    </div>
                  </Td>
                  <Td className={evaluation.resolved ? "text-success" : "text-tomate"}>{evaluation.resolved ? "Sim" : "Não"}</Td>
                  <Td className={cn("whitespace-nowrap", evaluation.satisfied === false && "text-tomate", evaluation.satisfied === null && "text-ink-3")}>
                    {evaluation.satisfied === null ? "Sem reação" : evaluation.satisfied ? "Satisfeito" : "Insatisfeito"}
                  </Td>
                  <Td className="whitespace-nowrap text-ink-3">{dayTime(evaluation.createdAt, now)}</Td>
                  <Td align="right">
                    <Link href={`/inbox?conversa=${evaluation.conversationId}`} className="text-xs whitespace-nowrap text-tomate underline underline-offset-2">
                      Ver conversa
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}
