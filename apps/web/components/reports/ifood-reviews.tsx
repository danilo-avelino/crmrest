"use client";

import type { IfoodReviewDto, IfoodReviewPeriod, IfoodReviewsDto } from "@dishdesk/shared";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, InfoIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/use-now";
import { ApiError } from "@/lib/api";
import { count, remaining, score } from "@/lib/format";
import { cn } from "@/lib/utils";
import { BarRow, Card, Chip, EmptyState, ErrorState, LoadingState, Metric, Pill, type PillTone, plural, SectionLabel, share } from "./report-ui";

const DAY = 24 * 60 * 60 * 1000;
const MIN_ANSWER = 10;
const MAX_ANSWER = 300;

type Filter = "all" | "pending" | "low";

const STATUS: Record<string, { label: string; tone: PillTone }> = {
  CREATED: { label: "Processando", tone: "neutral" },
  NOT_REPLIED: { label: "Aguardando resposta", tone: "warning" },
  REPLIED: { label: "Respondida", tone: "success" },
  PUBLISHED: { label: "Publicada", tone: "success" },
};

const PERIOD_LABEL: Record<IfoodReviewPeriod, string> = { "7d": "últimos 7 dias", "30d": "últimos 30 dias", "90d": "últimos 90 dias" };

const dayMonth = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" });

/**
 * Avaliações das lojas do iFood (lidas do iFood a cada consulta): números do período no topo e cada avaliação num
 * cartão. As que aguardam resposta (nota abaixo de 5 com comentário, por até 5 dias) abrem a resposta ao clicar.
 */
export function IfoodReviews({ tenantId, period }: { tenantId: string; period: IfoodReviewPeriod }) {
  const { request } = useAuth();
  const [filter, setFilter] = useState<Filter>("all");
  const now = useNow(60_000);
  const query = useQuery({
    queryKey: ["ifood-reviews", tenantId, period],
    queryFn: () => request<IfoodReviewsDto>(`/reports/ifood-reviews?tenantId=${tenantId}&period=${period}`),
    placeholderData: keepPreviousData,
  });

  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState title="Não foi possível carregar as avaliações do iFood." onRetry={() => query.refetch()} />;

  const data = query.data;
  if (data.stores.length === 0 && data.unavailable.length === 0) {
    return (
      <Card className="max-w-xl">
        <div className="flex items-start gap-3.5 rounded-[10px] bg-paper p-4">
          <div className="flex size-[38px] shrink-0 items-center justify-center rounded-[9px] bg-ifood text-[13px] font-bold text-white">iF</div>
          <div>
            <div className="text-sm font-semibold">Nenhuma loja do iFood conectada</div>
            <div className="mt-[3px] text-[12.5px] text-ink-2">Conecte sua loja para ver e responder as avaliações por aqui.</div>
            <Link href="/configuracoes/integracoes" className="mt-2.5 inline-block text-[12.5px] font-medium text-tomate hover:underline hover:underline-offset-2">
              Ir para Integrações →
            </Link>
          </div>
        </div>
      </Card>
    );
  }

  const reviews = data.reviews;
  const low = reviews.filter((review) => review.score < 5);
  const pending = reviews.filter((review) => review.status === "NOT_REPLIED");
  const urgent = pending.filter((review) => review.replyBy && Date.parse(review.replyBy) - now < DAY).length;
  const shown = filter === "pending" ? pending : filter === "low" ? low : reviews;
  const manyStores = data.stores.length + data.unavailable.length > 1;
  const others = data.stores.length === 1 ? "da outra loja" : `das outras ${count(data.stores.length)} lojas`;

  return (
    <>
      {data.unavailable.map((store) =>
        store.reason === "forbidden" ? (
          <div key={store.id} className="mb-5 flex items-center gap-3 rounded-[10px] border border-warning-line bg-warning-lt px-4 py-3 text-[13px] text-warning-ink">
            <InfoIcon className="size-4 shrink-0 text-warning" aria-hidden />
            <span>
              <b>{store.name}:</b> o iFood ainda não liberou as avaliações desta loja.
              {data.stores.length > 0 && ` Os números abaixo são ${others}.`}
            </span>
          </div>
        ) : (
          <div key={store.id} className="mb-5 flex items-center gap-2.5 rounded-[10px] bg-tomate-lt px-3.5 py-3 text-[12.5px] text-tomate-ink">
            <AlertTriangleIcon className="size-[18px] shrink-0 text-tomate" aria-hidden />
            <span>
              <b>{store.name}:</b> não foi possível ler as avaliações do iFood agora.
            </span>
          </div>
        ),
      )}

      {data.stores.length > 0 && (
        <>
          <div className="mb-5 grid grid-cols-4 gap-3">
            <StoreScore stores={data.stores} />
            <Metric label="Avaliações no período" value={count(reviews.length)} detail={PERIOD_LABEL[period]} />
            <Metric
              label="Abaixo de 5 estrelas"
              value={count(low.length)}
              tone={low.length ? "danger" : "ink"}
              detail={reviews.length ? `${share(low.length, reviews.length)} das avaliações` : "nenhuma avaliação"}
            />
            <Metric
              label="Aguardando resposta"
              value={count(pending.length)}
              tone={pending.length ? "danger" : "ink"}
              detail={pending.length ? `${count(urgent)} ${urgent === 1 ? "vence" : "vencem"} em menos de 24 h` : "nenhuma pendente"}
            />
          </div>

          <div className="mb-6 grid grid-cols-2 items-start gap-3">
            <div>
              <SectionLabel>Distribuição das notas</SectionLabel>
              <Card>
                <Distribution reviews={reviews} />
              </Card>
            </div>
            <div>
              <SectionLabel>Mais citados nas notas abaixo de 5</SectionLabel>
              <Card>
                <TopAnswers reviews={low} />
              </Card>
            </div>
          </div>

          <div className="mb-3.5 flex gap-2" role="group" aria-label="Filtro">
            <Chip active={filter === "all"} onClick={() => setFilter("all")}>
              Todas
            </Chip>
            <Chip active={filter === "pending"} onClick={() => setFilter("pending")}>
              Aguardando resposta · {count(pending.length)}
            </Chip>
            <Chip active={filter === "low"} onClick={() => setFilter("low")}>
              Abaixo de 5 · {count(low.length)}
            </Chip>
          </div>
          {shown.length === 0 ? (
            <Card>
              <EmptyState
                title={filter === "pending" ? "Nenhuma avaliação aguardando resposta." : "Nenhuma avaliação neste período."}
                hint={filter === "all" && period !== "90d" ? "Tente 90 dias para ver mais resultados." : undefined}
              />
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {shown.map((review) => (
                <ReviewBox key={`${review.storeId}-${review.id}`} review={review} tenantId={tenantId} showStore={manyStores} now={now} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

/** Nota da loja no iFood; com várias lojas, a média ponderada pelas avaliações válidas. */
function StoreScore({ stores }: { stores: IfoodReviewsDto["stores"] }) {
  const rated = stores.filter((store) => store.score !== null && store.validReviews > 0);
  const valid = rated.reduce((sum, store) => sum + store.validReviews, 0);
  const value = valid ? rated.reduce((sum, store) => sum + store.score! * store.validReviews, 0) / valid : null;
  return (
    <Metric
      label="Nota no iFood"
      value={value === null ? "—" : score(value)}
      suffix={value === null ? undefined : "/ 5"}
      detail={
        rated.length > 1
          ? `média ponderada das ${count(rated.length)} lojas, últimos 3 meses`
          : `${plural(valid, "avaliação válida", "avaliações válidas")} nos últimos 3 meses`
      }
    />
  );
}

function Distribution({ reviews }: { reviews: IfoodReviewDto[] }) {
  if (reviews.length === 0) return <p className="py-1.5 text-[13px] text-ink-3">Nenhuma avaliação no período.</p>;
  const totals = [5, 4, 3, 2, 1].map((stars) => ({ stars, total: reviews.filter((review) => Math.round(review.score) === stars).length }));
  const max = Math.max(...totals.map((item) => item.total));
  return totals.map(({ stars, total }) => (
    <BarRow
      key={stars}
      label={
        <span className="tracking-[2px] text-star" aria-label={`${stars} ${stars === 1 ? "estrela" : "estrelas"}`}>
          {"★".repeat(stars)}
        </span>
      }
      labelWidth="90px"
      tone="ink"
      value={total}
      max={max}
      text={`${count(total)} · ${share(total, reviews.length)}`}
    />
  ));
}

function TopAnswers({ reviews }: { reviews: IfoodReviewDto[] }) {
  const counts = new Map<string, number>();
  for (const answer of reviews.flatMap((review) => review.answers)) counts.set(answer, (counts.get(answer) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length === 0) return <p className="py-1.5 text-[13px] text-ink-3">Nenhum motivo informado no período.</p>;
  return top.map(([answer, total]) => <BarRow key={answer} label={answer} value={total} max={top[0]![1]} text={count(total)} />);
}

/** Uma avaliação. Aguardando resposta: clicar no cartão abre o campo de resposta. */
function ReviewBox({ review, tenantId, showStore, now }: { review: IfoodReviewDto; tenantId: string; showStore: boolean; now: number }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Resposta aceita pelo iFood, mostrada até a lista chegar com ela. */
  const [sent, setSent] = useState<string | null>(null);
  const status = STATUS[review.status] ?? { label: review.status, tone: "neutral" as const };
  const canReply = review.status === "NOT_REPLIED" && !sent && review.replyBy !== null && Date.parse(review.replyBy) > now;
  const replies = sent && !review.replies.length ? [{ text: sent, from: "MERCHANT", createdAt: null }] : review.replies;
  const length = text.trim().length;
  const customer = review.customerName ?? "Cliente do iFood";

  const send = async () => {
    setError(null);
    try {
      await request(`/reports/ifood-reviews/${review.storeId}/${encodeURIComponent(review.id)}/answer?tenantId=${tenantId}`, {
        method: "POST",
        body: { text: text.trim() },
      });
      setSent(text.trim());
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["ifood-reviews", tenantId] });
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível enviar ao iFood.");
    }
  };

  return (
    <article
      className={cn("rounded-2xl border border-rule-soft bg-surface px-[22px] py-5", canReply && !open && "cursor-pointer hover:border-rule")}
      onClick={canReply && !open ? () => setOpen(true) : undefined}
    >
      <header className="flex items-center gap-3">
        <ScoreStars value={review.score} />
        <b className="truncate text-sm">{customer}</b>
        <span className="truncate text-[12.5px] text-ink-3">
          {dayMonth.format(new Date(review.createdAt)).replace(" de ", " ").replace(".", "")}
          {review.orderCode && ` · Pedido #${review.orderCode}`}
          {showStore && ` · ${review.storeName}`}
        </span>
        <div className="flex-1" />
        {review.visibility === "PRIVATE" && <Pill tone="neutral">Privada</Pill>}
        {sent ? <Pill tone="success">Respondida</Pill> : <Pill tone={status.tone}>{status.label}</Pill>}
      </header>

      {review.comment ? (
        <p className="mt-3 text-sm leading-[1.55] whitespace-pre-line">{review.comment}</p>
      ) : (
        <p className="mt-3 text-sm text-ink-3 italic">Sem comentário.</p>
      )}

      {review.answers.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {review.answers.map((answer) => (
            <span key={answer} className="rounded-lg border border-dashed border-tag-line px-[9px] py-[3px] text-xs text-ink-2">
              {answer}
            </span>
          ))}
        </div>
      )}

      {replies.map((reply, index) =>
        reply.from === "CUSTOMER" ? (
          <div key={index} className="mt-2 ml-6 rounded-[10px] border border-rule-soft bg-paper/50 px-3.5 py-3 text-[13px]">
            <b>{customer}:</b> <span className="text-ink-2">{reply.text}</span>
          </div>
        ) : (
          <div key={index} className="mt-3.5 rounded-[10px] bg-paper px-3.5 py-3 text-[13px]">
            <b>{review.storeName} respondeu:</b> <span className="text-ink-2">{reply.text}</span>
          </div>
        ),
      )}

      {canReply && !open && (
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-rule-soft pt-3.5">
          <span className="text-xs font-semibold text-tomate">Responda em até {timeLeft(review.replyBy!, now)}</span>
          <Button onClick={() => setOpen(true)}>Responder</Button>
        </div>
      )}

      {open && (
        <div className="mt-4 border-t border-rule-soft pt-4">
          <div className="mb-2 flex items-center justify-between">
            <label htmlFor={fieldId} className="text-[12.5px] font-semibold">
              Sua resposta
            </label>
            {review.replyBy && <span className="text-xs font-semibold text-tomate">Responda em até {timeLeft(review.replyBy, now)}</span>}
          </div>
          <textarea
            id={fieldId}
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={MAX_ANSWER}
            rows={3}
            autoFocus
            aria-invalid={Boolean(error) || undefined}
            className="min-h-[76px] w-full resize-none rounded-[10px] border border-rule bg-surface px-3.5 py-3 text-[13.5px] leading-[1.5] outline-none placeholder:text-ink-3 focus-visible:border-ink focus-visible:ring-3 focus-visible:ring-ink/8 aria-invalid:border-tomate"
            placeholder="Agradeça, explique o que aconteceu e o que a loja vai fazer."
          />
          {error && (
            <p role="alert" className="mt-1 text-xs text-tomate">
              {error}
            </p>
          )}
          <div className="mt-2 flex items-center justify-between text-xs text-ink-3">
            <span>
              Sem dados pessoais nem links · {MIN_ANSWER} a {MAX_ANSWER} caracteres
            </span>
            <span className={cn("tabular-nums", length > 0 && length < MIN_ANSWER && "text-tomate")}>
              {length}/{MAX_ANSWER}
            </span>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              Cancelar
            </Button>
            <Button variant="accent" disabled={length < MIN_ANSWER} onClick={send}>
              Enviar
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

function ScoreStars({ value }: { value: number }) {
  const stars = Math.round(value);
  return (
    <span className="shrink-0 text-base tracking-[2px]" aria-label={`Nota ${stars} de 5`}>
      <span className="text-star">{"★".repeat(stars)}</span>
      <span className="text-rule">{"★".repeat(5 - stars)}</span>
    </span>
  );
}

/** Prazo restante: "3 dias", "1 dia" ou, no último dia, "18h" / "45 min". */
function timeLeft(iso: string, now: number): string {
  const days = Math.floor((Date.parse(iso) - now) / DAY);
  return days >= 1 ? `${days} ${days === 1 ? "dia" : "dias"}` : remaining(iso, now);
}
