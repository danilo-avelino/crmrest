import { RequireAdminContext } from "@/components/auth/require-context";
import { NavRail } from "@/components/inbox/nav-rail";

/** Avaliações: só administradores. Desktop por enquanto. */
export default function RatingsLayout({ children }: LayoutProps<"/avaliacoes">) {
  return (
    <RequireAdminContext>
      <div className="flex h-screen overflow-hidden bg-paper">
        <NavRail />
        {children}
      </div>
    </RequireAdminContext>
  );
}
