"use client";

import type { AuthContext } from "@dishdesk/shared";
import { CheckIcon, ChevronDownIcon, LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, type ReactNode, useContext, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { NavRail } from "@/components/inbox/nav-rail";
import { buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type SettingsTenant = AuthContext["tenants"][number];

const TABS = [
  { href: "/configuracoes", label: "Links de pedido" },
  { href: "/configuracoes/mensagens", label: "Mensagens automáticas" },
  { href: "/configuracoes/horario", label: "Horário" },
  { href: "/configuracoes/respostas-rapidas", label: "Respostas rápidas" },
  { href: "/configuracoes/integracoes", label: "Integrações" },
  { href: "/configuracoes/usuarios", label: "Usuários" },
];

const SettingsTenantContext = createContext<SettingsTenant | null>(null);

/** O restaurante cujas configurações estão na tela (no painel master, o escolhido no seletor). */
export function useSettingsTenant(): SettingsTenant {
  const tenant = useContext(SettingsTenantContext);
  if (!tenant) throw new Error("useSettingsTenant precisa estar dentro de <SettingsShell>");
  return tenant;
}

/**
 * Configurações: cabeçalho com as abas do board Campanhas e o título do board Clientes (o design ainda não tem
 * um board de Configurações). No painel master, um seletor escolhe o restaurante para todas as abas. Desktop no MVP.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const pathname = usePathname();
  const tenants = session?.context?.tenants ?? [];
  const adminTenants = tenants.filter((t) => t.role === "ADMIN");
  const [tenantId, setTenantId] = useState(() => adminTenants[0]?.id);
  const tenant = adminTenants.find((t) => t.id === tenantId) ?? adminTenants[0];
  const integrations = pathname.startsWith("/configuracoes/integracoes");
  if (!tenant) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-paper">
      <NavRail />
      <main className="flex flex-1 flex-col overflow-hidden bg-surface">
        <header className="shrink-0 border-b border-rule-soft px-7 pt-5">
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <h1 className="mb-[3px] font-heading text-[21px] font-bold tracking-[-0.3px]">Configurações</h1>
              <p className="text-[12px] text-ink-3">{adminTenants.length > 1 ? "Painel master" : tenant.name}</p>
            </div>
            {adminTenants.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger aria-label="Escolher o restaurante" className={buttonVariants({ variant: "outline", size: "sm" })}>
                  {tenant.name}
                  <ChevronDownIcon aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  {adminTenants.map((item) => (
                    <DropdownMenuItem key={item.id} onClick={() => setTenantId(item.id)}>
                      <span className="flex-1">{item.name}</span>
                      <span className="text-[10.5px] text-ink-3">admin</span>
                      {item.id === tenant.id && <CheckIcon className="size-3.5" aria-hidden />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          <nav aria-label="Seções das configurações" className="-mb-px flex">
            {TABS.map((tab) => {
              const active = tab.href === "/configuracoes" ? pathname === tab.href : pathname.startsWith(tab.href);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "border-b-2 px-[11px] py-[7px] text-[12px]",
                    active ? "border-ink font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink-2",
                  )}
                >
                  {tab.label}
                </Link>
              );
            })}
          </nav>
        </header>
        {/* Integrações (board Configurações · Integrações): cartões brancos sobre o papel, na largura da tela; as outras abas ficam numa coluna estreita. */}
        <div className={cn("flex-1 overflow-y-auto px-7 py-6", integrations && "bg-paper px-8")}>
          <div className={integrations ? "max-w-[1400px]" : "max-w-[680px]"}>
            <SettingsTenantContext value={tenant}>{children}</SettingsTenantContext>
          </div>
        </div>
      </main>
    </div>
  );
}

/** Carregamento (ou falha) de uma aba. */
export function TabLoading({ failed }: { failed: boolean }) {
  return (
    <div className="flex items-center gap-2 text-ink-3" aria-busy={!failed}>
      {failed ? (
        "Não foi possível carregar as configurações."
      ) : (
        <>
          <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
          Carregando…
        </>
      )}
    </div>
  );
}
