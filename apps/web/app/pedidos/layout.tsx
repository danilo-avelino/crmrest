import { RequireAdminContext } from "@/components/auth/require-context";
import { NavRail } from "@/components/inbox/nav-rail";

/** Pedidos das integrações: só administradores. Desktop por enquanto. */
export default function OrdersLayout({ children }: LayoutProps<"/pedidos">) {
  return (
    <RequireAdminContext>
      <div className="flex h-screen overflow-hidden bg-paper">
        <NavRail />
        {children}
      </div>
    </RequireAdminContext>
  );
}
