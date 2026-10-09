import { RequireSuperAdmin } from "@/components/auth/require-context";
import { NavRail } from "@/components/inbox/nav-rail";

/** Painel da plataforma (Super Admin, E16): só a equipe da plataforma. Desktop no MVP. */
export default function PlatformLayout({ children }: LayoutProps<"/plataforma">) {
  return (
    <RequireSuperAdmin>
      <div className="flex h-screen overflow-hidden bg-paper">
        <NavRail />
        {children}
      </div>
    </RequireSuperAdmin>
  );
}
