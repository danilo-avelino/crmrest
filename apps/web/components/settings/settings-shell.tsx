"use client";

import type { AuthContext } from "@dishdesk/shared";
import { LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, type ReactNode, useContext, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TenantPicker } from "@/components/auth/tenant-picker";
import { NavRail } from "@/components/inbox/nav-rail";
import { cn } from "@/lib/utils";

type SettingsTenant = AuthContext["tenants"][number];

const TABS = [
  { href: "/configuracoes", label: "Links de pedido" },
  { href: "/configuracoes/mensagens", label: "Mensagens automáticas" },
  { href: "/configuracoes/horario", label: "Horário" },
  { href: "/configuracoes/respostas-rapidas", label: "Respostas rápidas" },
  { href: "/configuracoes/integracoes", label: "Integrações" },
  { href: "/configuracoes/usuarios", label: "Usuários" },
  { href: "/configuracoes/pagamento", label: "Pagamento" },
];

type SettingsTenants = { tenant: SettingsTenant; tenants: SettingsTenant[]; choose: (tenantId: string) => void };

const SettingsTenantContext = createContext<SettingsTenants | null>(null);

function useSettingsTenants(): SettingsTenants {
  const value = useContext(SettingsTenantContext);
  if (!value) throw new Error("useSettingsTenant precisa estar dentro de <SettingsShell>");
  return value;
}

/** O restaurante cujas configurações estão na tela (no painel master, o escolhido no seletor). */
export function useSettingsTenant(): SettingsTenant {
  return useSettingsTenants().tenant;
}

/** O seletor de restaurante do painel master, para a aba que o põe ao lado do próprio título. */
export function SettingsTenantPicker() {
  const { tenant, tenants, choose } = useSettingsTenants();
  return <TenantPicker tenants={tenants} tenant={tenant} onChange={choose} />;
}

/**
 * Configurações: cabeçalho com as abas do board Campanhas e o título do board Clientes (o design ainda não tem
 * um board de Configurações). No painel master, um seletor no topo do conteúdo escolhe o restaurante para todas as abas.
 * Desktop no MVP.
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
    <div className="flex h-full overflow-hidden bg-paper">
      <NavRail />
      <main className="flex flex-1 flex-col overflow-hidden bg-surface">
        <header className="shrink-0 border-b border-rule-soft px-7 pt-5">
          <div className="mb-3">
            <h1 className="mb-[3px] font-heading text-[21px] font-bold tracking-[-0.3px]">Configurações</h1>
            <p className="text-[12px] text-ink-3">{adminTenants.length > 1 ? "Painel master" : tenant.name}</p>
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
        {/* Integrações (board Configurações · Integrações): cartões brancos sobre o papel, na largura do board; as outras abas ficam numa coluna estreita. */}
        <div className={cn("flex-1 overflow-y-auto px-7 py-6", integrations && "bg-paper px-8")}>
          <div className={integrations ? "max-w-[1072px]" : "max-w-[680px]"}>
            {/* Integrações põe o seletor ao lado do título; as outras abas não têm título fora dos cartões. */}
            {!integrations && adminTenants.length > 1 && (
              <div className="mb-4">
                <TenantPicker tenants={adminTenants} tenant={tenant} onChange={setTenantId} />
              </div>
            )}
            <SettingsTenantContext value={{ tenant, tenants: adminTenants, choose: setTenantId }}>{children}</SettingsTenantContext>
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
