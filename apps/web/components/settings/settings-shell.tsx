"use client";

import type { AuthContext } from "@dishdesk/shared";
import { BellIcon, BookOpenIcon, BotIcon, CirclePauseIcon, ClockIcon, CreditCardIcon, LinkIcon, LoaderCircleIcon, MegaphoneIcon, PlugIcon, SparklesIcon, TicketPercentIcon, UsersIcon, ZapIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { createContext, type ReactNode, useContext, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { NavRail } from "@/components/inbox/nav-rail";
import { SideMenu, type SideMenuGroup } from "@/components/layout/side-menu";
import { useMenu } from "@/components/menu/use-menu";

type SettingsTenant = AuthContext["tenants"][number];

/** O menu de Configurações, em grupos. A primeira página (/configuracoes) é a Personalidade. */
const NAV: SideMenuGroup[] = [
  {
    group: "Atendimento",
    items: [
      { href: "/configuracoes", label: "Personalidade", icon: SparklesIcon },
      { href: "/configuracoes/horario", label: "Horário", icon: ClockIcon },
      { href: "/configuracoes/links", label: "Links de pedido", icon: LinkIcon },
      { href: "/configuracoes/respostas-rapidas", label: "Respostas rápidas", icon: ZapIcon },
    ],
  },
  { group: "Conexões", items: [{ href: "/configuracoes/integracoes", label: "Integrações", icon: PlugIcon }] },
  {
    group: "Equipe",
    items: [
      { href: "/configuracoes/usuarios", label: "Usuários", icon: UsersIcon },
      { href: "/configuracoes/notificacoes", label: "Notificações", icon: BellIcon },
    ],
  },
  {
    group: "Conta",
    items: [
      { href: "/configuracoes/pagamento", label: "Pagamento", icon: CreditCardIcon },
      { href: "/configuracoes/pausa", label: "Pausa", icon: CirclePauseIcon },
    ],
  },
];

/** Só com o módulo Cardápio ligado (a mesma checagem do menu lateral). */
const MENU_NAV: SideMenuGroup = {
  group: "Cardápio",
  items: [
    { href: "/configuracoes/cardapio", label: "Cardápio e entrega", icon: BookOpenIcon },
    { href: "/configuracoes/pagamentos-cardapio", label: "Pagamentos do cardápio", icon: CreditCardIcon },
    { href: "/configuracoes/pedidos-ia", label: "Pedidos pela IA", icon: BotIcon },
    { href: "/configuracoes/vantagens", label: "Vantagens por tag", icon: TicketPercentIcon },
    { href: "/configuracoes/meta-ads", label: "Meta Ads", icon: MegaphoneIcon },
  ],
};

const SettingsTenantContext = createContext<SettingsTenant | null>(null);

/** O restaurante cujas configurações estão na tela (no painel master, o escolhido no seletor). */
export function useSettingsTenant(): SettingsTenant {
  const value = useContext(SettingsTenantContext);
  if (!value) throw new Error("useSettingsTenant precisa estar dentro de <SettingsShell>");
  return value;
}

/** As abas de Configurações fora do <SettingsShell> (o assistente de configuração), para um restaurante só. */
export function SettingsTenantProvider({ tenant, children }: { tenant: SettingsTenant; children: ReactNode }) {
  return <SettingsTenantContext value={tenant}>{children}</SettingsTenantContext>;
}

/**
 * Configurações: menu lateral em grupos e, ao lado, a página escolhida, em cartões brancos sobre o papel (o design só
 * tem board para Integrações; o menu segue a lista de passos do board do assistente de configuração). No painel
 * master, o seletor no topo do menu escolhe o restaurante para todas as páginas. Desktop no MVP.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const pathname = usePathname();
  const tenants = session?.context?.tenants ?? [];
  const adminTenants = tenants.filter((t) => t.role === "ADMIN");
  const menuOn = useMenu().isSuccess;
  const [tenantId, setTenantId] = useState(() => adminTenants[0]?.id);
  const tenant = adminTenants.find((t) => t.id === tenantId) ?? adminTenants[0];
  if (!tenant) return null;

  return (
    <div className="flex h-full overflow-hidden bg-paper">
      <NavRail />
      <SideMenu
        title="Configurações"
        label="Seções das configurações"
        root="/configuracoes"
        nav={menuOn ? [...NAV.slice(0, 2), MENU_NAV, ...NAV.slice(2)] : NAV}
        tenants={adminTenants}
        tenant={tenant}
        onTenantChange={setTenantId}
      />
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-7">
        {/* Integrações e Pedidos pela IA (formulário e simulação lado a lado) usam a largura do board; as outras páginas ficam numa coluna de leitura. */}
        <div className={pathname.startsWith("/configuracoes/integracoes") || pathname.startsWith("/configuracoes/pedidos-ia") ? "max-w-[1072px]" : "max-w-[760px]"}>
          <SettingsTenantContext value={tenant}>{children}</SettingsTenantContext>
        </div>
      </main>
    </div>
  );
}

/** Carregamento (ou falha) de uma página. */
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
