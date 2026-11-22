"use client";

import { StarIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { usePendingAction } from "@/hooks/use-pending-action";
import { orderToken, type PublicOrder } from "@/lib/public-order";
import { cn } from "@/lib/utils";

// Acompanhamento do pedido (W15, F3-09): linha do tempo, nota depois de entregue e aviso no navegador (R16: a
// permissão só é pedida aqui, depois de um pedido feito, e só quando o cliente toca no botão).

const STEP_LABEL: Record<string, string> = {
  PLACED: "Pedido recebido",
  CONFIRMED: "Confirmado pela loja",
  PREPARING: "Em preparo",
  READY: "Pronto",
  DISPATCHED: "Saiu para entrega",
  DELIVERED: "Entregue",
  CANCELED: "Cancelado",
};

/** Etapas que faltam depois da última conhecida, para mostrar o caminho todo. */
export function timelineSteps(order: Pick<PublicOrder, "status" | "mode" | "timeline">): { code: string; label: string; at: string | null; done: boolean }[] {
  const flow = order.mode === "PICKUP" ? ["PLACED", "CONFIRMED", "PREPARING", "READY", "DELIVERED"] : ["PLACED", "CONFIRMED", "PREPARING", "DISPATCHED", "DELIVERED"];
  const seen = new Map((order.timeline ?? []).filter((e) => STEP_LABEL[e.code]).map((e) => [e.code, e.at]));
  if (order.status === "CANCELED") {
    return [...seen.entries()].map(([code, at]) => ({ code, label: STEP_LABEL[code]!, at, done: true }));
  }
  const reached = Math.max(flow.indexOf(order.status), ...[...seen.keys()].map((code) => flow.indexOf(code)));
  return flow.map((code, i) => ({
    code,
    label: code === "READY" ? "Pronto para retirar" : STEP_LABEL[code]!,
    at: seen.get(code) ?? null,
    done: i <= reached,
  }));
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

export function OrderTimeline({ order }: { order: PublicOrder }) {
  const steps = timelineSteps(order);
  return (
    <ol className="m-0 flex list-none flex-col gap-2.5 rounded-lg border border-rule bg-surface p-4" aria-label="Andamento do pedido">
      {steps.map((step) => (
        <li key={step.code} className="flex items-center gap-2.5">
          <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", step.done ? (step.code === "CANCELED" ? "bg-tomate" : "bg-success") : "border border-rule bg-surface")} />
          <span className={cn("flex-1", !step.done && "text-ink-3")}>{step.label}</span>
          {step.at && <span className="text-[12px] text-ink-3 tabular-nums">{hhmm(step.at)}</span>}
        </li>
      ))}
    </ol>
  );
}

export function OrderRating({ slug, order, onRated }: { slug: string; order: PublicOrder; onRated: (rating: number) => void }) {
  const [score, setScore] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [send, sending] = usePendingAction(async () => {
    setError(null);
    const token = orderToken(order.id);
    const response = await fetch(`/api/public/menu/${encodeURIComponent(slug)}/orders/${encodeURIComponent(order.id)}/rating`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(token ? { "X-Order-Token": token } : {}) },
      body: JSON.stringify({ score }),
    });
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    if (!response.ok) return setError(body.message ?? "Não foi possível enviar a nota. Tente de novo.");
    onRated(score);
  });

  if (order.rating) {
    return (
      <p role="status" className="m-0 rounded-lg border border-rule bg-surface p-3 text-center text-ink-2">
        Obrigado pela nota {order.rating} de 5!
      </p>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-rule bg-surface p-4">
      <p className="m-0 font-medium">Como foi o seu pedido?</p>
      <div className="flex gap-1" role="radiogroup" aria-label="Nota de 1 a 5">
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={score === value}
            aria-label={`${value} de 5`}
            onClick={() => setScore(value)}
            className="flex size-11 items-center justify-center rounded-lg"
          >
            <StarIcon className={cn("size-7", value <= score ? "fill-warning text-warning" : "text-ink-3")} aria-hidden />
          </button>
        ))}
      </div>
      <Button onClick={send} loading={sending} disabled={score === 0}>
        Enviar nota
      </Button>
      {error && (
        <p role="alert" className="m-0 text-[12.5px] text-tomate">
          {error}
        </p>
      )}
    </div>
  );
}

/** Aviso do navegador quando o pedido muda de etapa (só se o cliente permitiu e a página está aberta). */
export function notifyStatus(status: string) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    new Notification("Seu pedido", { body: STEP_LABEL[status] ?? "O pedido mudou de etapa." });
  } catch {
    // Navegador sem notificações (navegador interno do WhatsApp): o acompanhamento continua na tela.
  }
}

/** R16: pede a permissão só depois do pedido feito e só no toque do cliente. Some sem suporte ou já respondido. */
export function NotifyButton() {
  const [state, setState] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  if (state !== "default") return null;
  return (
    <button
      type="button"
      className="h-11 rounded-md border border-rule bg-surface font-medium"
      onClick={() => void Notification.requestPermission().then(setState).catch(() => setState("unsupported"))}
    >
      Avisar neste celular quando o pedido mudar
    </button>
  );
}
