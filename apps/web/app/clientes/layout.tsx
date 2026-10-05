import { RequireAdminContext } from "@/components/auth/require-context";
import { NavRail } from "@/components/inbox/nav-rail";

/** Lista, detalhe e duplicados compartilham a navegação lateral (board Clientes). Desktop por enquanto. */
export default function ClientsLayout({ children }: LayoutProps<"/clientes">) {
  return (
    <RequireAdminContext>
      <div className="flex h-screen overflow-hidden bg-paper">
        <NavRail />
        {children}
      </div>
    </RequireAdminContext>
  );
}
