"use client";

import { DISPUTE_REASON_LABEL, type OrderAction, type OrderCancellationReason, type OrderDispute, type OrderListItem } from "@dishdesk/shared";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircleIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { clock } from "@/lib/format";
import { cn } from "@/lib/utils";

const ACTION_LABEL: Record<OrderAction, string> = {
  CONFIRM: "Confirmar pedido",
  READY: "Marcar como pronto",
  DISPATCH: "Despachar",
};

/** Modal de escolha do motivo, comum ao cancelamento e à resposta ao pedido do cliente. */
type ReasonPicker = {
  title: string;
  confirm: string;
  reasons: OrderCancellationReason[];
  /** Sem motivos a escolher: o aviso mostrado e se ainda dá para seguir. */
  empty: { text: string; blocked: boolean };
  run: (code: string | null) => Promise<void>;
};

/**
 * O que a equipe informa ao iFood pela aba Pedidos: um botão só, que muda com o status; o cancelamento, com os motivos
 * do iFood; e a resposta ao pedido de cancelamento do cliente. O iFood só aceita o pedido de mudança: o resultado chega
 * pelo polling, então os botões dão lugar a um aviso até o pedido mudar.
 */
export function OrderActions({ order }: { order: OrderListItem }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = useId();
  /** Situação do pedido quando o iFood aceitou a última ação: enquanto for a mesma, o resultado ainda não chegou. */
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [picker, setPicker] = useState<ReasonPicker | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { dispute } = order;
  const situation = `${order.status}:${dispute?.id ?? ""}`;
  const waiting = sentAt === situation;

  useEffect(() => {
    if (!waiting) return;
    const refresh = setInterval(() => void queryClient.invalidateQueries({ queryKey: ["orders"] }), 5_000);
    const giveUp = setTimeout(() => setSentAt(null), 90_000);
    return () => {
      clearInterval(refresh);
      clearTimeout(giveUp);
    };
  }, [waiting, queryClient]);

  if (!order.nextAction && !order.cancelable && !dispute) return null;

  const open = (next: ReasonPicker) => {
    setCode(null);
    setError(null);
    setPicker(next);
  };
  const failed = (failure: unknown) => toast(failure instanceof ApiError ? failure.message : "Não foi possível falar com o iFood.");

  const advance = async () => {
    try {
      await request(`/orders/${order.id}/advance`, { method: "POST" });
      setSentAt(situation);
    } catch (failure) {
      failed(failure);
    }
  };
  const openCancel = async () => {
    try {
      const { reasons } = await request<{ reasons: OrderCancellationReason[] }>(`/orders/${order.id}/cancellation-reasons`);
      open({
        title: "Cancelar pedido",
        confirm: "Cancelar pedido",
        reasons,
        empty: { text: "O iFood não permite cancelar este pedido agora.", blocked: true },
        run: (chosen) => request(`/orders/${order.id}/cancel`, { method: "POST", body: { code: chosen } }),
      });
    } catch (failure) {
      failed(failure);
    }
  };
  const answer = (accept: boolean, pending: OrderDispute) =>
    open({
      title: accept ? "Aceitar o pedido do cliente" : "Recusar o pedido do cliente",
      confirm: accept ? "Aceitar" : "Recusar",
      reasons: (accept ? pending.acceptReasons : Object.keys(DISPUTE_REASON_LABEL)).map((reason) => ({
        code: reason,
        description: DISPUTE_REASON_LABEL[reason] ?? reason,
      })),
      empty: { text: "Ao aceitar, o iFood cancela o que o cliente pediu.", blocked: false },
      run: (chosen) => request(`/orders/${order.id}/dispute`, { method: "POST", body: { accept, ...(chosen && { reason: chosen }) } }),
    });
  const confirm = async () => {
    setError(null);
    try {
      await picker!.run(code);
      setPicker(null);
      setSentAt(situation);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível enviar ao iFood.");
    }
  };

  return (
    <div className="col-span-2 flex flex-col gap-2">
      {dispute && !waiting && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-[7px] border border-warning-line bg-warning-lt px-3.5 py-2.5 text-xs">
          <span>
            <span className="font-medium">{DISPUTE_TITLE[dispute.action] ?? "O cliente abriu uma negociação no iFood"}</span>
            {dispute.message && <>: “{dispute.message}”</>}
            <span className="text-ink-2">
              {dispute.expiresAt && <> · Responda até {clock(dispute.expiresAt)}.</>}
              {dispute.timeoutAction && TIMEOUT_TEXT[dispute.timeoutAction] && <> {TIMEOUT_TEXT[dispute.timeoutAction]}</>}
            </span>
          </span>
          <span className="flex shrink-0 gap-1.5">
            <Button variant="ghost" size="xs" onClick={() => answer(false, dispute)}>
              Recusar
            </Button>
            <Button variant="outline" size="xs" onClick={() => answer(true, dispute)}>
              Aceitar
            </Button>
          </span>
        </div>
      )}
      <div className="flex items-center justify-end gap-1.5">
        {waiting ? (
          <span role="status" className="text-[11px] text-ink-3">
            Enviado ao iFood. O pedido atualiza em instantes…
          </span>
        ) : (
          <>
            {order.cancelable && (
              <Button variant="ghost" size="xs" onClick={openCancel}>
                Cancelar pedido
              </Button>
            )}
            {order.nextAction && (
              <Button variant="outline" size="xs" onClick={advance}>
                {ACTION_LABEL[order.nextAction]}
              </Button>
            )}
          </>
        )}
      </div>
      <Dialog open={picker !== null} onOpenChange={(next) => !next && setPicker(null)}>
        <DialogContent className="w-[440px]">
          <div className="border-b border-rule px-6 py-5">
            <DialogTitle className="mb-1">{picker?.title}</DialogTitle>
            <DialogDescription>
              Pedido iFood #{order.displayCode ?? order.id.slice(0, 6)} · a resposta vai para o iFood e não dá para desfazer
            </DialogDescription>
          </div>
          <div className="px-6 py-[18px]">
            {picker?.reasons.length ? (
              <div role="radiogroup" aria-label="Motivo" className="mb-4 flex max-h-[280px] flex-col gap-1.5 overflow-y-auto">
                {picker.reasons.map((reason) => (
                  <label
                    key={reason.code}
                    className={cn(
                      "cursor-pointer rounded-lg border px-3 py-2 text-[13px] hover:bg-paper has-focus-visible:ring-3 has-focus-visible:ring-ring/8",
                      code === reason.code ? "border-ink bg-paper" : "border-rule",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${id}-reason`}
                      value={reason.code}
                      checked={code === reason.code}
                      onChange={() => setCode(reason.code)}
                      className="sr-only"
                    />
                    {reason.description}
                  </label>
                ))}
              </div>
            ) : (
              <p className="mb-4 rounded-md bg-paper px-3.5 py-2.5 text-[12.5px] leading-normal text-ink-3">{picker?.empty.text}</p>
            )}
            {error && (
              <p role="alert" className="mb-3 flex items-center gap-[5px] text-[11.5px] text-tomate">
                <AlertCircleIcon className="size-3 shrink-0" aria-hidden />
                {error}
              </p>
            )}
            <div className="flex gap-2">
              {picker && !(picker.reasons.length === 0 && picker.empty.blocked) && (
                <Button variant="destructive" disabled={picker.reasons.length > 0 && !code} onClick={confirm}>
                  {picker.confirm}
                </Button>
              )}
              <Button variant="outline" onClick={() => setPicker(null)}>
                {picker?.reasons.length === 0 && picker.empty.blocked ? "Fechar" : "Voltar"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const DISPUTE_TITLE: Record<string, string> = {
  CANCELLATION: "O cliente pediu o cancelamento do pedido",
  PARTIAL_CANCELLATION: "O cliente pediu o cancelamento de parte do pedido",
};

/** O que o iFood faz sozinho se a loja não responder no prazo. */
const TIMEOUT_TEXT: Record<string, string> = {
  ACCEPT_CANCELLATION: "Sem resposta, o iFood cancela.",
  REJECT_CANCELLATION: "Sem resposta, o iFood recusa o pedido do cliente.",
};
