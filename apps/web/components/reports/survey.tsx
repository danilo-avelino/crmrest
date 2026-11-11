"use client";

import { count, score } from "@/lib/format";
import { ReportPage, RestaurantName } from "./ratings-shell";
import { BarRow, Card, ConversationLink, EmptyState, Metric, plural, Row, ScoreBadge, SectionLabel, share, Table, when } from "./report-ui";

/** Avaliações → Pesquisa: as notas que os clientes deram na pesquisa enviada no fim do atendimento. */
export function Survey() {
  return (
    <ReportPage title="Pesquisa" description="Nota de 1 a 5 que o cliente dá na pesquisa enviada pelo WhatsApp no fim de um atendimento com pedido do dia">
      {({ summary, scoreCounts, recent }, { now, hint }) => (
        <>
          <div className="mb-5 grid grid-cols-4 items-start gap-3">
            <Metric
              label="Nota média dos clientes"
              value={summary.averageScore === null ? "—" : score(summary.averageScore)}
              suffix={summary.averageScore === null ? undefined : "/ 5"}
              detail={plural(summary.ratings, "resposta à pesquisa", "respostas à pesquisa")}
            />
            <Card className="col-span-3">
              <div className="mb-1 text-xs font-semibold text-ink-2">Distribuição das notas</div>
              {summary.ratings === 0 ? (
                <p className="py-1.5 text-[13px] text-ink-3">Nenhuma resposta à pesquisa no período.</p>
              ) : (
                [5, 4, 3, 2, 1].map((value) => (
                  <BarRow
                    key={value}
                    label={`Nota ${value}`}
                    labelWidth="70px"
                    tone={value <= 2 ? "tomate" : "ink"}
                    value={scoreCounts[value - 1]!}
                    max={Math.max(...scoreCounts)}
                    text={`${count(scoreCounts[value - 1]!)} · ${share(scoreCounts[value - 1]!, summary.ratings)}`}
                  />
                ))
              )}
            </Card>
          </div>
          <SectionLabel>Últimas respostas</SectionLabel>
          <Table
            cols="44px minmax(0,1.3fr) minmax(0,1.2fr) minmax(0,0.8fr) minmax(0,0.9fr) 100px"
            head={["Nota", "Cliente", "Atendente", "Pedido", "Quando", ""]}
            empty={<EmptyState title="Nenhuma resposta à pesquisa neste período." hint={hint} />}
          >
            {recent.map((rating) => (
              <Row key={rating.id}>
                <ScoreBadge value={rating.score} />
                <span className="min-w-0">
                  <b className="block truncate font-semibold">{rating.contactName ?? "Cliente sem nome"}</b>
                  <RestaurantName tenantId={rating.tenantId} />
                </span>
                {rating.agentName ?? <span className="text-tomate">Sem resposta da equipe</span>}
                <span className="tabular-nums">{rating.orderCode ? `#${rating.orderCode}` : "—"}</span>
                <span className="whitespace-nowrap text-ink-2">{when(rating.createdAt, now)}</span>
                <ConversationLink id={rating.conversationId} />
              </Row>
            ))}
          </Table>
        </>
      )}
    </ReportPage>
  );
}
