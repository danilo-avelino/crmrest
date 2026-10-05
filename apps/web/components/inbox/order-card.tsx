import { CHANNEL_LABEL, type OrderDto } from "@comanda/shared";
import { CHANNEL_DOT } from "@/components/inbox/bits";
import { clock, currency } from "@/lib/format";
import { cn } from "@/lib/utils";

export const ORDER_STATUS: Record<OrderDto["status"], { label: string; className: string }> = {
  PLACED: { label: "Novo", className: "text-tomate-ink" },
  CONFIRMED: { label: "Confirmado", className: "text-warning" },
  PREPARING: { label: "Em preparo", className: "text-warning" },
  DISPATCHED: { label: "Em entrega", className: "text-warning" },
  DELIVERED: { label: "Entregue", className: "text-success" },
  CANCELED: { label: "Cancelado", className: "text-tomate" },
};

/** Card do pedido dentro da conversa (board Inbox → "Card do pedido iFood"; o Cardápio Web usa o mesmo card). */
export function OrderCard({ order }: { order: OrderDto }) {
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
      <div className="border-t border-rule bg-paper px-3.5 py-[7px] text-[10.5px] text-ink-3 tabular-nums">
        {footer.join(" · ")}
      </div>
    </div>
  );
}
