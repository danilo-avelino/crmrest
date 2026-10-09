"use client";

import {
  Building2Icon,
  MegaphoneIcon,
  MessageSquareIcon,
  ReceiptTextIcon,
  ScrollTextIcon,
  SettingsIcon,
  StarIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/auth-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePendingAction } from "@/hooks/use-pending-action";
import { cn } from "@/lib/utils";

// Campanhas chega nas próximas fases. Atendentes só usam a Inbox (as outras páginas são de administrador).
const ITEMS = [
  { label: "Inbox", icon: MessageSquareIcon, href: "/inbox", adminOnly: false },
  { label: "Pedidos", icon: ReceiptTextIcon, href: "/pedidos", adminOnly: true },
  { label: "Clientes", icon: UsersIcon, href: "/clientes", adminOnly: true },
  { label: "Avaliações", icon: StarIcon, href: "/avaliacoes", adminOnly: true },
  { label: "Campanhas", icon: MegaphoneIcon, href: null, adminOnly: true },
  { label: "Configurações", icon: SettingsIcon, href: "/configuracoes", adminOnly: true },
];

// Painel da plataforma (só super admin): no pé da barra, de baixo para cima a partir do avatar.
const PLATFORM_ITEMS = [
  { label: "Auditoria da plataforma", icon: ScrollTextIcon, href: "/plataforma/auditoria" },
  { label: "Restaurantes da plataforma", icon: Building2Icon, href: "/plataforma" },
];

const ITEM_CLASS = "mt-1 flex size-9 items-center justify-center rounded-lg first-of-type:mt-0";

/** Navegação lateral escura de 56px (boards Inbox e Clientes). */
export function NavRail() {
  const { session, logout, switchContext } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [signOut] = usePendingAction(() => logout());
  if (!session?.context) return null;
  const context = session.context;
  const isAdmin = context.tenants.some((tenant) => tenant.role === "ADMIN");

  return (
    <nav className="flex w-14 shrink-0 flex-col items-center gap-0.5 border-r border-[#2D2A24] bg-ink py-4">
      <div className="mb-5 flex size-8 items-center justify-center rounded-lg bg-tomate">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <rect x="3" y="4" width="10" height="1.5" rx="0.75" className="fill-paper" />
          <rect x="3" y="7.25" width="7" height="1.5" rx="0.75" className="fill-paper" />
          <rect x="3" y="10.5" width="4.5" height="1.5" rx="0.75" className="fill-ink" />
        </svg>
      </div>

      {ITEMS.filter((item) => isAdmin || !item.adminOnly).map(({ label, icon: Icon, href }) => {
        if (!href) {
          return (
            <button
              key={label}
              type="button"
              aria-label={label}
              title={`${label} (em breve)`}
              disabled
              className={cn(ITEM_CLASS, "text-[#5C5750] disabled:cursor-not-allowed")}
            >
              <Icon className="size-[18px]" aria-hidden />
            </button>
          );
        }
        const active = pathname.startsWith(href);
        return (
          <Link
            key={label}
            href={href}
            aria-label={label}
            title={label}
            aria-current={active ? "page" : undefined}
            className={cn(ITEM_CLASS, active ? "bg-[#2D2A24] text-paper" : "text-[#5C5750] hover:bg-[#2D2A24] hover:text-paper")}
          >
            <Icon className="size-[18px]" aria-hidden />
          </Link>
        );
      })}

      <div className="flex-1" />

      {session.user.isSuperAdmin && (
        <div className="mb-3 flex flex-col items-center">
          <div className="mb-2 h-px w-6 bg-[#2D2A24]" aria-hidden />
          {PLATFORM_ITEMS.map(({ label, icon: Icon, href }) => {
            const active = href === "/plataforma" ? pathname === href : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-label={label}
                title={label}
                aria-current={active ? "page" : undefined}
                className={cn(ITEM_CLASS, active ? "bg-[#2D2A24] text-paper" : "text-[#5C5750] hover:bg-[#2D2A24] hover:text-paper")}
              >
                <Icon className="size-[18px]" aria-hidden />
              </Link>
            );
          })}
        </div>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Conta"
          title={context.support ? "Acesso de suporte" : undefined}
          className={cn(
            "flex size-8 items-center justify-center rounded-full border-[1.5px] border-[#5C5750] bg-[#3D3A34] text-xs font-semibold text-[#DDD8D0]",
            context.support && "border-warning",
          )}
        >
          {session.user.name.charAt(0)}
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" className="w-60">
          <div className="px-1.5 py-1">
            <div className="text-[13px] font-medium">{session.user.name}</div>
            <div className="text-[11px] text-ink-3">
              {context.mode === "master" ? "Painel master" : context.tenants[0]?.name}
              {context.support && " · acesso de suporte"}
            </div>
          </div>
          <DropdownMenuSeparator />
          {(session.tenants.length > 1 || context.support) && (
            <DropdownMenuItem
              onClick={() => {
                switchContext();
                router.push("/login");
              }}
            >
              Trocar de restaurante
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => signOut()}>Sair</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}
