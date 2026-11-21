import type { OrderDto } from "@dishdesk/shared";
import { StatusBadge } from "@/components/common/bits";

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
