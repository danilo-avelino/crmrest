"use client";

import { MegaphoneIcon, MessageSquareIcon, SettingsIcon, UsersIcon } from "lucide-react";
import { useRouter } from "next/navigation";
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

// Só a Inbox existe no MVP; Clientes, Campanhas e Configurações chegam nas próximas fases.
const ITEMS = [
  { label: "Inbox", icon: MessageSquareIcon, ready: true },
  { label: "Clientes", icon: UsersIcon, ready: false },
  { label: "Campanhas", icon: MegaphoneIcon, ready: false },
  { label: "Configurações", icon: SettingsIcon, ready: false },
];

/** Navegação lateral escura de 56px (board Inbox). */
export function NavRail() {
  const { session, logout, switchContext } = useAuth();
  const router = useRouter();
  const [signOut] = usePendingAction(() => logout());
  if (!session?.context) return null;
  const context = session.context;

  return (
    <nav className="flex w-14 shrink-0 flex-col items-center gap-0.5 border-r border-[#2D2A24] bg-ink py-4">
      <div className="mb-5 flex size-8 items-center justify-center rounded-lg bg-tomate">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <rect x="3" y="4" width="10" height="1.5" rx="0.75" className="fill-paper" />
          <rect x="3" y="7.25" width="7" height="1.5" rx="0.75" className="fill-paper" />
          <rect x="3" y="10.5" width="4.5" height="1.5" rx="0.75" className="fill-ink" />
        </svg>
      </div>

      {ITEMS.map(({ label, icon: Icon, ready }) => (
        <button
          key={label}
          type="button"
          aria-label={label}
          title={ready ? label : `${label} (em breve)`}
          aria-current={ready ? "page" : undefined}
          disabled={!ready}
          className={cn(
            "mt-1 flex size-9 items-center justify-center rounded-lg first-of-type:mt-0",
            ready ? "bg-[#2D2A24] text-paper" : "text-[#5C5750] disabled:cursor-not-allowed",
          )}
        >
          <Icon className="size-[18px]" aria-hidden />
        </button>
      ))}

      <div className="flex-1" />

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Conta"
          className="flex size-8 items-center justify-center rounded-full border-[1.5px] border-[#5C5750] bg-[#3D3A34] text-xs font-semibold text-[#DDD8D0]"
        >
          {session.user.name.charAt(0)}
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" className="w-60">
          <div className="px-1.5 py-1">
            <div className="text-[13px] font-medium">{session.user.name}</div>
            <div className="text-[11px] text-ink-3">
              {context.mode === "master" ? "Painel master" : context.tenants[0]?.name}
            </div>
          </div>
          <DropdownMenuSeparator />
          {session.tenants.length > 1 && (
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
