"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SparklesIcon } from "lucide-react";
import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/use-now";
import { CART_STAGE_LABEL, CART_STAGE_TONE, type CartStage, pixCountdown } from "@/lib/cart-stage";
import { currency } from "@/lib/format";
import { cn } from "@/lib/utils";

type ConversationCart = {
  ai: "on" | "off" | null;
  cart: {
    id: string;
    stage: CartStage;
    items: { id: string; name: string; size: string | null; half: string | null; options: string[]; quantity: number; notes: string | null; totalCents: number }[];
    subtotalCents: number;
    deliveryFeeCents: number;
    totalCents: number;
    pixExpiresAt: string | null;
  } | null;
};

/**
 * "Carrinho pela IA" no painel do cliente (F4-10): o que o agente de pedidos montou, o total e a etapa, com
 * "Assumir conversa" (a IA para) e "Devolver à IA". Some sem carrinho ou com o módulo Cardápio desligado.
 */
export function AiCart({ conversationId }: { conversationId: string }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const now = useNow();
  const query = useQuery({
    queryKey: ["conversation-cart", conversationId],
    queryFn: () => request<ConversationCart>(`/conversations/${conversationId}/cart`),
    refetchInterval: 30_000,
  });
  const cart = query.data?.cart;
  if (!cart) return null;
  const ai = query.data?.ai;
  const countdown = cart.stage === "awaiting_pix" ? pixCountdown(cart.pixExpiresAt, now) : null;

  const setAi = async (on: boolean) => {
    await request(`/conversations/${conversationId}/cart/ai`, { method: "POST", body: { on } });
    await queryClient.invalidateQueries({ queryKey: ["conversation-cart", conversationId] });
  };

  return (
    <div className="flex flex-col gap-3 border-b border-rule px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">
          <SparklesIcon className="size-3" aria-hidden />
          Carrinho pela IA
        </div>
        <span className={cn("text-[12px] font-semibold", CART_STAGE_TONE[cart.stage])}>
          {CART_STAGE_LABEL[cart.stage]}
          {countdown && <span className="ml-1 tabular-nums">· {countdown}</span>}
        </span>
      </div>

      <ul className="flex flex-col gap-1.5 text-[13px]">
        {cart.items.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <span className="font-semibold">
                {item.quantity}× {item.name}
              </span>
              {(item.size || item.half || item.options.length > 0) && (
                <div className="text-[11px] text-ink-3">{[item.size, item.half && `½ ${item.half}`, ...item.options].filter(Boolean).join(" · ")}</div>
              )}
              {item.notes && <div className="text-[11px] text-ink-3 italic">Obs.: {item.notes}</div>}
            </div>
            <span className="shrink-0 text-ink-2 tabular-nums">{currency(item.totalCents / 100)}</span>
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-0.5 border-t border-rule pt-2 text-[12px] text-ink-2">
        {cart.deliveryFeeCents > 0 && (
          <div className="flex justify-between">
            <span>Entrega</span>
            <span className="tabular-nums">{currency(cart.deliveryFeeCents / 100)}</span>
          </div>
        )}
        <div className="flex justify-between text-[14px] font-semibold text-ink">
          <span>Total</span>
          <span className="tabular-nums">{currency(cart.totalCents / 100)}</span>
        </div>
      </div>

      {ai === "on" && (
        <Button variant="outline" size="sm" onClick={() => setAi(false)}>
          Assumir conversa
        </Button>
      )}
      {ai === "off" && (
        <Button variant="outline" size="sm" onClick={() => setAi(true)}>
          Devolver à IA
        </Button>
      )}
    </div>
  );
}
