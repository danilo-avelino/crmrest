import type { MenuOrderInfo } from "@dishdesk/shared";
import { StatusBadge } from "@/components/common/bits";
import { menuBadges } from "@/lib/menu-order";

/** Selos do pedido do cardápio próprio (pagamento e agendamento); nada nos demais pedidos. */
export function MenuBadgeList({ menu, className }: { menu: MenuOrderInfo | null | undefined; className?: string }) {
  const badges = menuBadges(menu);
  if (badges.length === 0) return null;
  return (
    <div className={className ?? "flex flex-wrap gap-1"}>
      {badges.map((badge) => (
        <StatusBadge key={badge.key} tone={badge.tone}>
          {badge.label}
        </StatusBadge>
      ))}
    </div>
  );
}
