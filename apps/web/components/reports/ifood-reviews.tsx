"use client";

import type { IfoodReviewDto, IfoodReviewPeriod, IfoodReviewsDto } from "@dishdesk/shared";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircleIcon, StarIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { StatusBadge } from "@/components/inbox/bits";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/use-now";
import { ApiError } from "@/lib/api";
import { count, dayTime, remaining, score } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Metric, plural, Section } from "./ratings-report";

const DAY = 24 * 60 * 60 * 1000;
const MIN_ANSWER = 10;
const MAX_ANSWER = 300;

type Filter = "all" | "pending" | "low";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Todas" },
  { value: "pending", label: "Aguardando resposta" },
  { value: "low", label: "Abaixo de 5" },
];

const STATUS: Record<string, { label: string; tone: "pending" | "resolved" | "neutral" }> = {
  CREATED: { label: "Processando", tone: "neutral" },
  NOT_REPLIED: { label: "Aguardando resposta", tone: "pending" },
  REPLIED: { label: "Respondida", tone: "resolved" },
  PUBLISHED: { label: "Publicada", tone: "neutral" },
};

/**
 * Avaliações das lojas do iFood (lidas do iFood a cada consulta): números do período no topo e cada avaliação numa
 * caixa. As que aguardam resposta (nota abaixo de 5 com comentário, por até 5 dias) abrem a resposta ao clicar.
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

  if (query.isPending) {
    return (
      <Body>
        <p className="text-[13px] text-ink-3" aria-busy>
          Carregando…
        </p>
      </Body>
    );
  }
  if (query.isError) {
    return (
      <Body>
        <Notice title="Não foi possível carregar as avaliações do iFood" text="Verifique sua conexão e tente novamente.">
          <Button variant="outline" size="sm" onClick={() => query.refetch()}>
            Tentar novamente
          </Button>
        </Notice>
      </Body>
    );
  }

  const data = query.data;
  if (data.stores.length === 0 && data.unavailable.length === 0) {
    return (
      <Body>
        <Notice tone="info" title="Nenhuma loja do iFood conectada" text="Conecte a loja para ver e responder as avaliações dos clientes por aqui.">
          <Link href="/configuracoes/integracoes" className="text-xs text-tomate underline underline-offset-2">
            Ir para Integrações
          </Link>
        </Notice>
      </Body>
    );
  }

  const reviews = data.reviews;
  const low = reviews.filter((review) => review.score < 5);
  const pending = reviews.filter((review) => review.status === "NOT_REPLIED");
  const average = reviews.length ? reviews.reduce((sum, review) => sum + review.score, 0) / reviews.length : null;
  const nextDeadline = pending.map((review) => review.replyBy!).sort()[0];
  const shown = filter === "pending" ? pending : filter === "low" ? low : reviews;
  const manyStores = data.stores.length + data.unavailable.length > 1;

  return (
    <Body>
      <div className="flex max-w-[1100px] flex-col gap-6">
        {data.unavailable.map((store) => (
          <Notice
            key={store.id}
            tone="warning"
            title={store.reason === "forbidden" ? `O iFood ainda não liberou as avaliações de ${store.name}` : `Não foi possível ler as avaliações de ${store.name}`}
            text={
              store.reason === "forbidden"
                ? "O acesso às avaliações depende da homologação do módulo de avaliações no iFood. As demais lojas aparecem normalmente."
                : "O iFood não respondeu agora. Tente de novo em alguns minutos."
            }
          />
        ))}

        {data.stores.length > 0 && (
          <>
            <div className="grid grid-cols-4 gap-3">
              <Metric
                label="Avaliações no período"
                value={count(reviews.length)}
                detail={average === null ? "nenhuma avaliação" : `nota média ${score(average)}`}
              />
              <Metric
                label="Abaixo de 5 estrelas"
                value={count(low.length)}
                detail={reviews.length ? `${percent(low.length, reviews.length)} das avaliações` : "—"}
              />
              <Metric
                label="Aguardando resposta"
                value={count(pending.length)}
                detail={nextDeadline ? `a próxima perde o prazo em ${timeLeft(nextDeadline, now)}` : "nenhuma pendente"}
              />
              <StoreScore stores={data.stores} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Section title="Notas no período">
                <Distribution reviews={reviews} />
              </Section>
              <Section title="Mais citados nas notas abaixo de 5" note="Respostas do questionário do iFood.">
                <TopAnswers reviews={low} />
              </Section>
            </div>

            <div>
              <div className="mb-3 flex items-center justify-between gap-4">
                <div className="flex gap-1.5" role="group" aria-label="Filtro">
                  {FILTERS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      aria-pressed={filter === item.value}
                      onClick={() => setFilter(item.value)}
                      className={cn(
                        "inline-flex h-[30px] items-center gap-1.5 rounded-md border px-3 text-xs whitespace-nowrap",
                        filter === item.value ? "border-ink bg-ink text-paper" : "border-rule bg-surface text-ink-2 hover:bg-paper",
                      )}
                    >
                      {item.label}
                      <span className="tabular-nums opacity-70">{count(item.value === "pending" ? pending.length : item.value === "low" ? low.length : reviews.length)}</span>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-ink-3">O iFood dá 5 dias para responder; depois disso, a avaliação é publicada sem resposta.</p>
              </div>
              {shown.length === 0 ? (
                <p className="rounded-xl border border-rule bg-surface px-5 py-6 text-[13px] text-ink-3">
                  {filter === "pending" ? "Nenhuma avaliação aguardando resposta." : "Nenhuma avaliação no período."}
                </p>
              ) : (
                <div className="grid grid-cols-2 items-start gap-3">
                  {shown.map((review) => (
                    <ReviewBox key={`${review.storeId}-${review.id}`} review={review} tenantId={tenantId} showStore={manyStores} now={now} />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Body>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return <div className="flex-1 overflow-y-auto bg-paper px-7 py-6">{children}</div>;
}

const NOTICE = {
  error: { box: "border-tomate-line bg-tomate-lt", icon: "text-tomate" },
  warning: { box: "max-w-none border-warning-line bg-warning-lt", icon: "text-warning" },
  info: { box: "border-rule bg-surface", icon: "text-ink-3" },
};

function Notice({ title, text, tone = "error", children }: { title: string; text: string; tone?: keyof typeof NOTICE; children?: React.ReactNode }) {
  return (
    <div className={cn("flex max-w-lg items-start gap-3 rounded-xl border p-5", NOTICE[tone].box)}>
      <AlertCircleIcon className={cn("mt-px size-[18px] shrink-0", NOTICE[tone].icon)} aria-hidden />
      <div>
        <div className="mb-1 text-[13px] font-medium">{title}</div>
        <div className={cn("text-xs text-ink-3", children && "mb-2.5")}>{text}</div>
        {children}
      </div>
    </div>
  );
}

/** Nota da loja no iFood; com várias lojas, a média ponderada pelas avaliações válidas. */
function StoreScore({ stores }: { stores: IfoodReviewsDto["stores"] }) {
  const rated = stores.filter((store) => store.score !== null && store.validReviews > 0);
  const valid = rated.reduce((sum, store) => sum + store.validReviews, 0);
  const value = valid ? rated.reduce((sum, store) => sum + store.score! * store.validReviews, 0) / valid : null;
  return (
    <Metric
      label={stores.length > 1 ? "Nota das lojas no iFood" : "Nota no iFood"}
      value={value === null ? "—" : score(value)}
      detail={`${plural(valid, "avaliação válida", "avaliações válidas")} nos últimos 3 meses`}
      star={value !== null}
    />
  );
}

function Distribution({ reviews }: { reviews: IfoodReviewDto[] }) {
  if (reviews.length === 0) return <p className="px-5 py-6 text-[13px] text-ink-3">Nenhuma avaliação no período.</p>;
  return (
    <ul className="flex flex-col gap-2 px-5 py-4">
      {[5, 4, 3, 2, 1].map((stars) => {
        const total = reviews.filter((review) => Math.round(review.score) === stars).length;
        return (
          <li key={stars} className="flex items-center gap-3 text-xs tabular-nums">
            <span className="inline-flex w-7 items-center gap-0.5 text-ink-2">
              {stars}
              <StarIcon className="size-3 fill-warning text-warning" aria-hidden />
            </span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
              <span className={cn("block h-full rounded-full", stars >= 4 ? "bg-success" : stars === 3 ? "bg-warning" : "bg-tomate")} style={{ width: `${(total / reviews.length) * 100}%` }} />
            </span>
            <span className="w-24 text-right text-ink-3">
              {count(total)} · {percent(total, reviews.length)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function TopAnswers({ reviews }: { reviews: IfoodReviewDto[] }) {
  const counts = new Map<string, number>();
  for (const answer of reviews.flatMap((review) => review.answers)) counts.set(answer, (counts.get(answer) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length === 0) return <p className="px-5 py-6 text-[13px] text-ink-3">Nenhum motivo informado no período.</p>;
  return (
    <ul className="flex flex-col px-5 py-2">
      {top.map(([answer, total]) => (
        <li key={answer} className="flex items-center justify-between border-b border-rule-soft py-2 text-[13px] last:border-0">
          <span>{answer}</span>
          <span className="text-xs text-ink-3 tabular-nums">{plural(total, "vez", "vezes")}</span>
        </li>
      ))}
    </ul>
  );
}

/** Uma avaliação. Aguardando resposta: clicar na caixa abre o campo de resposta. */
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
      className={cn("rounded-xl border bg-surface px-5 py-4", canReply && !open ? "cursor-pointer border-warning-line hover:bg-paper" : "border-rule")}
      onClick={canReply && !open ? () => setOpen(true) : undefined}
    >
      <header className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ScoreStars value={review.score} />
            <span className="truncate text-[13px] font-medium">{review.customerName ?? "Cliente do iFood"}</span>
          </div>
          <div className="mt-0.5 text-xs text-ink-3">
            {dayTime(review.createdAt, now)}
            {review.orderCode && ` · pedido #${review.orderCode}`}
            {showStore && ` · ${review.storeName}`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {review.visibility === "PRIVATE" && <StatusBadge tone="neutral">Privada</StatusBadge>}
          <StatusBadge tone={sent ? "resolved" : status.tone}>{sent ? "Respondida" : status.label}</StatusBadge>
        </div>
      </header>

      <p className={cn("text-[13px] leading-[1.5] whitespace-pre-line", !review.comment && "text-ink-3 italic")}>{review.comment ?? "Sem comentário."}</p>

      {review.answers.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {review.answers.map((answer) => (
            <span key={answer} className="rounded-sm border border-dashed border-tag-line px-2 py-px text-[11px] text-ink-2">
              {answer}
            </span>
          ))}
        </div>
      )}

      {replies.map((reply, index) => (
        <div key={index} className={cn("mt-3 rounded-lg px-3.5 py-2.5 text-[13px] leading-[1.5]", reply.from === "CUSTOMER" ? "border border-rule bg-paper" : "bg-surface-2")}>
          <div className="mb-0.5 text-[11px] font-medium text-ink-3">{reply.from === "CUSTOMER" ? "Cliente" : "Resposta da loja"}</div>
          {reply.text}
        </div>
      ))}

      {canReply && !open && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-rule-soft pt-3">
          <span className="text-xs text-warning-ink">Responda em até {timeLeft(review.replyBy!, now)}</span>
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            Responder
          </Button>
        </div>
      )}

      {open && (
        <div className="mt-3 border-t border-rule-soft pt-3">
          <label htmlFor={fieldId} className="mb-1.5 block text-[13px] font-medium">
            Resposta ao cliente
          </label>
          <textarea
            id={fieldId}
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={MAX_ANSWER}
            rows={3}
            autoFocus
            aria-invalid={Boolean(error) || undefined}
            className="w-full resize-none rounded-lg border border-rule bg-surface px-3 py-2 text-[13px] leading-[1.5] outline-none placeholder:text-ink-3 focus-visible:border-ink focus-visible:ring-3 focus-visible:ring-ink/8 aria-invalid:border-tomate"
            placeholder="Agradeça, explique o que aconteceu e o que a loja vai fazer. Sem dados pessoais do cliente nem links."
          />
          {error && (
            <p role="alert" className="mt-1 text-xs text-tomate">
              {error}
            </p>
          )}
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className={cn("text-xs tabular-nums", length > 0 && length < MIN_ANSWER ? "text-tomate" : "text-ink-3")}>
              {length}/{MAX_ANSWER} · mínimo de {MIN_ANSWER} caracteres
            </span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setOpen(false);
                  setError(null);
                }}
              >
                Cancelar
              </Button>
              <Button size="sm" disabled={length < MIN_ANSWER} onClick={send}>
                Enviar resposta
              </Button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function ScoreStars({ value }: { value: number }) {
  return (
    <span className="inline-flex gap-px" aria-label={`Nota ${value} de 5`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <StarIcon key={star} className={cn("size-3.5", star <= Math.round(value) ? "fill-warning text-warning" : "fill-surface-2 text-rule")} aria-hidden />
      ))}
    </span>
  );
}

function percent(part: number, total: number): string {
  return `${Math.round((part / total) * 100)}%`;
}

/** Prazo restante: "3 dias", "1 dia" ou, no último dia, "18h" / "45 min". */
function timeLeft(iso: string, now: number): string {
  const days = Math.floor((Date.parse(iso) - now) / DAY);
  return days >= 1 ? `${days} ${days === 1 ? "dia" : "dias"}` : remaining(iso, now);
}
