"use client";

import {
  BookOpenIcon,
  MegaphoneIcon,
  MessageSquareIcon,
  ReceiptTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
  StarIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/auth-provider";
import { DemoMenu } from "@/components/demo/demo-menu";
import { InboxWatcher } from "@/components/inbox/inbox-watcher";
import { useMenu } from "@/components/menu/use-menu";
import { useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePendingAction } from "@/hooks/use-pending-action";
import { readTheme, saveTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

// Campanhas chega nas próximas fases. Atendentes só usam a Inbox (as outras páginas são de administrador).
const ITEMS = [
  { label: "Inbox", icon: MessageSquareIcon, href: "/inbox", adminOnly: false },
  { label: "Pedidos", icon: ReceiptTextIcon, href: "/pedidos", adminOnly: true },
  { label: "Clientes", icon: UsersIcon, href: "/clientes", adminOnly: true },
  { label: "Avaliações", icon: StarIcon, href: "/avaliacoes", adminOnly: true },
  { label: "Cardápio", icon: BookOpenIcon, href: "/cardapio", adminOnly: true, module: "MENU" },
  { label: "Campanhas", icon: MegaphoneIcon, href: null, adminOnly: true },
  { label: "Configurações", icon: SettingsIcon, href: "/configuracoes", adminOnly: true },
];

const ITEM_CLASS = "mt-1 flex size-9 items-center justify-center rounded-lg first-of-type:mt-0";

/** Navegação lateral escura de 56px (boards Inbox e Clientes). */
export function NavRail({ onHome }: { onHome?: () => void }) {
  const { session, logout, switchContext } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [signOut] = usePendingAction(() => logout());
  // O Cardápio é um módulo: a API responde 403 quando ele não está ligado no restaurante, e aí a entrada some.
  const menuOn = useMenu().isSuccess;
  // O tema salvo só existe no navegador. O menu só é desenhado aberto, então o servidor nunca mostra este valor.
  const [theme, setTheme] = useState<Theme>(() => (typeof window === "undefined" ? "system" : readTheme()));
  // Conta de demonstração: um toque longo no logo abre o menu escondido (simular cliente, resetar).
  const [demoOpen, setDemoOpen] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  if (!session?.context) return null;
  const context = session.context;
  const demoTenant = context.mode === "tenant" && context.tenants.length === 1 ? (session.tenants.find((tenant) => tenant.id === context.tenants[0]!.id && tenant.demo) ?? null) : null;
  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const demoPress = demoTenant
    ? {
        onPointerDown: () => {
          longPressed.current = false;
          cancelPress();
          pressTimer.current = setTimeout(() => {
            longPressed.current = true;
          }, 700);
        },
        // Abre ao soltar: aberto ainda com o dedo no logo, a soltura contaria como clique fora e fecharia o menu.
        onPointerUp: () => {
          cancelPress();
          if (longPressed.current) setDemoOpen(true);
        },
        onPointerLeave: cancelPress,
        onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
      }
    : {};
  const isAdmin = context.tenants.some((tenant) => tenant.role === "ADMIN");

  return (
    <nav className="theme-light flex w-14 shrink-0 flex-col items-center gap-0.5 border-r border-[#2D2A24] bg-ink py-4">
      {/* Na Inbox a lista já cuida dos avisos; nas outras páginas eles continuam por aqui. */}
      {!pathname.startsWith("/inbox") && <InboxWatcher />}
      {demoTenant && <DemoMenu tenantId={demoTenant.id} open={demoOpen} onOpenChange={setDemoOpen} />}
      <Link
        href="/inbox"
        {...demoPress}
        onClick={(event) => {
          // O toque longo abriu o menu da demo: não navega.
          if (longPressed.current) {
            event.preventDefault();
            longPressed.current = false;
            return;
          }
          onHome?.();
        }}
        aria-label="Início da Inbox"
        title="Início"
        className="mb-5 flex size-8 items-center justify-center rounded-lg bg-tomate"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <rect x="3" y="4" width="10" height="1.5" rx="0.75" className="fill-paper" />
          <rect x="3" y="7.25" width="7" height="1.5" rx="0.75" className="fill-paper" />
          <rect x="3" y="10.5" width="4.5" height="1.5" rx="0.75" className="fill-ink" />
        </svg>
      </Link>

      {ITEMS.filter((item) => (isAdmin || !item.adminOnly) && (!item.module || menuOn)).map(({ label, icon: Icon, href }) => {
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

      {/* Painel da plataforma (só super admin): um ícone no pé da barra; as páginas ficam no menu lateral dele. */}
      {session.user.isSuperAdmin && (
        <div className="mb-3 flex flex-col items-center">
          <div className="mb-2 h-px w-6 bg-[#2D2A24]" aria-hidden />
          <Link
            href="/plataforma"
            aria-label="Plataforma"
            title="Plataforma"
            aria-current={pathname.startsWith("/plataforma") ? "page" : undefined}
            className={cn(
              ITEM_CLASS,
              pathname.startsWith("/plataforma") ? "bg-[#2D2A24] text-paper" : "text-[#5C5750] hover:bg-[#2D2A24] hover:text-paper",
            )}
          >
            <ShieldCheckIcon className="size-[18px]" aria-hidden />
          </Link>
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
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Tema</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(value: Theme) => {
                setTheme(value);
                saveTheme(value);
              }}
            >
              <DropdownMenuRadioItem value="light" closeOnClick>
                Claro
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark" closeOnClick>
                Escuro
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system" closeOnClick>
                Igual ao computador
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => signOut()}>Sair</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}
