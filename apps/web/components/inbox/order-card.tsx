"use client";

import { CHANNEL_LABEL, type OrderDto } from "@dishdesk/shared";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircleIcon } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { CHANNEL_DOT } from "@/components/inbox/bits";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { clock, currency } from "@/lib/format";
import { cn } from "@/lib/utils";

export const ORDER_STATUS: Record<OrderDto["status"], { label: string; className: string }> = {
  PLACED: { label: "Novo", className: "text-tomate-ink" },
  CONFIRMED: { label: "Confirmado", className: "text-warning" },
  PREPARING: { label: "Em preparo", className: "text-warning" },
  READY: { label: "Pronto", className: "text-warning" },
  DISPATCHED: { label: "Em entrega", className: "text-warning" },
  DELIVERED: { label: "Entregue", className: "text-success" },
  CANCELED: { label: "Cancelado", className: "text-tomate" },
};

/** Card do pedido dentro da conversa (board Inbox → "Card do pedido iFood"; o Cardápio Web usa o mesmo card). */
export function OrderCard({ order, conversationId }: { order: OrderDto; conversationId: string }) {
  const status = ORDER_STATUS[order.status];
  const footer = [
    `Realizado às ${clock(order.placedAt)}`,
    order.dispatchedAt && `Saiu da cozinha às ${clock(order.dispatchedAt)}`,
    order.deliveredAt && `Entregue às ${clock(order.deliveredAt)}`,
  ].filter(Boolean);

  return (
    <div className="ml-[29px] max-w-[360px] overflow-hidden rounded-[10px] border border-rule bg-surface">
      <div className="flex items-center justify-between border-b border-rule bg-paper px-3.5 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className={cn("size-[7px] shrink-0 rounded-full", CHANNEL_DOT[order.channelType])} />
          <span className="text-[11.5px] font-semibold">
            Pedido {CHANNEL_LABEL[order.channelType]} #{order.displayCode ?? order.id.slice(0, 6)}
          </span>
        </div>
        <span
          className={cn(
            "rounded-sm border border-warning-line bg-warning-lt px-[7px] py-0.5 text-[10.5px] font-medium",
            status.className,
          )}
        >
          {status.label}
        </span>
      </div>
      <div className="flex flex-col gap-[5px] px-3.5 py-2.5 text-[12.5px]">
        {order.items.map((item, index) => (
          <div key={index} className="flex justify-between">
            <span>
              {item.quantity}× {item.name}
            </span>
            <span className="text-ink-2 tabular-nums">{currency(Number(item.unitPrice) * item.quantity)}</span>
          </div>
        ))}
        {Number(order.deliveryFee) > 0 && (
          <div className="flex justify-between">
            <span>Taxa de entrega</span>
            <span className="text-ink-2 tabular-nums">{currency(order.deliveryFee)}</span>
          </div>
        )}
        <div className="my-1 h-px bg-rule" />
        <div className="flex justify-between text-[13px] font-semibold">
          <span>Total</span>
          <span className="tabular-nums">{currency(order.total)}</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-rule bg-paper px-3.5 py-[7px] text-[10.5px] text-ink-3 tabular-nums">
        <span>{footer.join(" · ")}</span>
        {NOTIFIABLE.has(order.status) && <ForecastButton order={order} conversationId={conversationId} />}
      </div>
    </div>
  );
}

/** Na cozinha (previsão de saída) ou a caminho (quando saiu): dá para avisar o cliente pelo botão. */
export const NOTIFIABLE = new Set<OrderDto["status"]>(["PLACED", "CONFIRMED", "PREPARING", "READY", "DISPATCHED"]);

/**
 * "Enviar previsão" (na cozinha) ou "Avisar saída" (já saiu): mostra a mensagem calculada (E26) e só envia depois que
 * o atendente confirma.
 */
export function ForecastButton({ order, conversationId }: { order: OrderDto; conversationId: string }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [preview, setPreview] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const dispatched = order.status === "DISPATCHED";

  const open = async () => {
    setError(null);
    try {
      setPreview((await request<{ text: string | null }>(`/orders/${order.id}/forecast`)).text);
    } catch (failure) {
      toast(failure instanceof ApiError ? failure.message : "Não foi possível calcular a previsão.");
    }
  };
  const send = async () => {
    setError(null);
    try {
      await request(`/conversations/${conversationId}/messages`, { method: "POST", body: { text: preview } });
      void queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      setPreview(undefined);
      toast(dispatched ? "Aviso enviado" : "Previsão enviada");
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível enviar.");
    }
  };

  return (
    <>
      <Button variant="outline" size="xs" onClick={open}>
        {dispatched ? "Avisar saída" : "Enviar previsão"}
      </Button>
      <Dialog open={preview !== undefined} onOpenChange={(next) => !next && setPreview(undefined)}>
        <DialogContent className="w-[440px]">
          <div className="border-b border-rule px-6 py-5">
            <DialogTitle className="mb-1">{dispatched ? "Avisar que o pedido saiu" : "Enviar previsão de saída"}</DialogTitle>
            <DialogDescription>
              Pedido {CHANNEL_LABEL[order.channelType]} #{order.displayCode ?? order.id.slice(0, 6)} · confira antes de enviar ao cliente
            </DialogDescription>
          </div>
          <div className="px-6 py-[18px]">
            {preview ? (
              <div className="mb-4 ml-auto max-w-[340px] rounded-[12px_12px_2px_12px] bg-ink px-3.5 py-2.5 text-[13px] leading-normal whitespace-pre-wrap text-paper">
                {preview}
              </div>
            ) : (
              <p className="mb-4 rounded-md bg-paper px-3.5 py-2.5 text-[12.5px] leading-normal text-ink-3">
                Ainda não há pedidos que já saíram do restaurante para calcular a previsão.
              </p>
            )}
            {error && (
              <p role="alert" className="mb-3 flex items-center gap-[5px] text-[11.5px] text-tomate">
                <AlertCircleIcon className="size-3 shrink-0" aria-hidden />
                {error}
              </p>
            )}
            <div className="flex gap-2">
              {preview && (
                <Button variant="accent" onClick={send}>
                  Enviar
                </Button>
              )}
              <Button variant="outline" onClick={() => setPreview(undefined)}>
                {preview ? "Cancelar" : "Fechar"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
