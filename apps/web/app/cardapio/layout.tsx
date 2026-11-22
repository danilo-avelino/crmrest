import { RequireAdminContext } from "@/components/auth/require-context";
import { NavRail } from "@/components/inbox/nav-rail";

/** Cardápio do painel (lista, ficha do item e complementos): só administradores, com a navegação lateral. Desktop por enquanto. */
export default function MenuLayout({ children }: LayoutProps<"/cardapio">) {
  return (
    <RequireAdminContext>
      <div className="flex h-full overflow-hidden bg-paper">
        <NavRail />
        {children}
      </div>
    </RequireAdminContext>
  );
}
