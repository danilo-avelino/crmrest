import { RequireAdminContext } from "@/components/auth/require-context";
import { MenuShell } from "@/components/menu/menu-shell";

/** Cardápio do painel (lista, ficha do item, complementos, funil e abandonados): só administradores, com a navegação lateral e a faixa das páginas. Desktop por enquanto. */
export default function MenuLayout({ children }: LayoutProps<"/cardapio">) {
  return (
    <RequireAdminContext>
      <MenuShell>{children}</MenuShell>
    </RequireAdminContext>
  );
}
