import type { OrderDto } from "@dishdesk/shared";
import { StatusBadge } from "@/components/common/bits";
import { cn } from "@/lib/utils";

type OrderStatus = OrderDto["status"];

type StatusInfo = {
  label: string;
  className: string;
  /** Cor do selo (StatusBadge). */
  tone: "open" | "pending" | "resolved";
  /** Cor do status no cabeçalho do bloco do pedido, quando difere de `className`. */
  headerClassName?: string;
};

export const ORDER_STATUS: Record<OrderStatus, StatusInfo> = {
  PLACED: { label: "Novo", className: "text-tomate-ink", tone: "open" },
  CONFIRMED: { label: "Confirmado", className: "text-warning", tone: "pending" },
  PREPARING: { label: "Em preparo", className: "text-warning", tone: "pending" },
  READY: { label: "Pronto", className: "text-warning", tone: "pending", headerClassName: "text-[#2F6FB7] dark:text-[#6EA8F0]" },
  DISPATCHED: { label: "Em entrega", className: "text-warning", tone: "resolved", headerClassName: "text-[#C2610F] dark:text-[#F08A3C]" },
  DELIVERED: { label: "Entregue", className: "text-success", tone: "resolved" },
  CANCELED: { label: "Cancelado", className: "text-tomate", tone: "open" },
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const { tone, label } = ORDER_STATUS[status];
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

/** Etapas da trilha do pedido (design: Pedidos e Inbox), na ordem. */
const STEPS: OrderStatus[] = ["PLACED", "CONFIRMED", "PREPARING", "READY", "DISPATCHED", "DELIVERED"];

/** Etapa do pedido na trilha: o que já saiu do restaurante conta como "Em entrega", mesmo sem o status da plataforma. */
export function orderStep(order: Pick<OrderDto, "status" | "dispatchedAt">): OrderStatus {
  return order.dispatchedAt && order.status !== "DELIVERED" && order.status !== "CANCELED" ? "DISPATCHED" : order.status;
}

/**
 * Trilha das seis etapas (design: "estado mostrado na forma"): preenchida até a etapa atual, em tomate se atrasado, em
 * verde quando entregue e listrada quando cancelado. O texto da etapa vai ao lado, por quem usa a trilha.
 */
export function OrderTrack({ status, late, className }: { status: OrderStatus; late?: boolean; className?: string }) {
  const canceled = status === "CANCELED";
  const step = STEPS.indexOf(status);
  return (
    <div
      role="img"
      aria-label={canceled ? "Pedido cancelado" : `Etapa ${step + 1} de ${STEPS.length}: ${ORDER_STATUS[status].label}`}
      className={cn("flex gap-[3px]", className)}
    >
      {STEPS.map((key, index) => (
        <i
          key={key}
          className={cn(
            "h-1.5 min-w-2.5 flex-1 rounded-[2px]",
            canceled
              ? "bg-[repeating-linear-gradient(135deg,var(--color-rule)_0_3px,transparent_3px_6px)]"
              : index <= step
                ? late
                  ? "bg-tomate"
                  : status === "DELIVERED"
                    ? "bg-success"
                    : "bg-ink"
                : "bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-rule)]",
          )}
        />
      ))}
    </div>
  );
}
