"use client";

import type { AuthContext } from "@dishdesk/shared";
import {
  AlignLeftIcon,
  BotIcon,
  ChartColumnIcon,
  CreditCardIcon,
  FunnelIcon,
  InfinityIcon,
  LayersIcon,
  LayoutGridIcon,
  MapPinIcon,
  MegaphoneIcon,
  ShoppingCartIcon,
  StoreIcon,
  Table2Icon,
  TagIcon,
  TicketIcon,
} from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { NavRail } from "@/components/inbox/nav-rail";
import { SideMenu, type SideMenuGroup } from "@/components/layout/side-menu";
import { SettingsTenantProvider } from "@/components/settings/settings-shell";

type Tenant = AuthContext["tenants"][number];

/** As páginas do Cardápio, no padrão do menu de Configurações (board Moldura). A primeira (/cardapio) é a lista de itens. */
const NAV: SideMenuGroup[] = [
  {
    group: "Catálogo",
    items: [
      { href: "/cardapio", label: "Itens e categorias", icon: AlignLeftIcon, match: ["/cardapio/item", "/cardapio/importar"] },
      { href: "/cardapio/complementos", label: "Complementos", icon: LayersIcon },
      { href: "/cardapio/opcoes", label: "Opções", icon: LayoutGridIcon, badge: "nova" },
      { href: "/cardapio/planilha", label: "Edição em planilha", icon: Table2Icon, badge: "nova" },
    ],
  },
  {
    group: "Vendas",
    items: [
      { href: "/cardapio/relatorio", label: "Relatório de vendas", icon: ChartColumnIcon, badge: "nova" },
      { href: "/cardapio/funil", label: "Funil de vendas", icon: FunnelIcon },
      { href: "/cardapio/abandonados", label: "Carrinhos abandonados", icon: ShoppingCartIcon },
    ],
  },
  {
    group: "Promoções",
    items: [
      { href: "/cardapio/cupons", label: "Cupons", icon: TicketIcon, badge: "nova" },
      { href: "/cardapio/vantagens", label: "Vantagens por tag", icon: TagIcon },
      { href: "/cardapio/avisos", label: "Avisos no cardápio", icon: MegaphoneIcon, badge: "nova" },
    ],
  },
  {
    group: "Loja",
    items: [
      { href: "/cardapio/entrega", label: "Cardápio e entrega", icon: StoreIcon },
      { href: "/cardapio/areas", label: "Áreas de entrega", icon: MapPinIcon, badge: "nova" },
      { href: "/cardapio/pagamentos", label: "Pagamentos do cardápio", icon: CreditCardIcon },
      { href: "/cardapio/pedidos-ia", label: "Pedidos pela IA", icon: BotIcon },
    ],
  },
  { group: "Marketing", items: [{ href: "/cardapio/meta-ads", label: "Meta Ads", icon: InfinityIcon }] },
];

const MenuTenantContext = createContext<string | null>(null);

/** O restaurante cujo cardápio está na tela (no painel master, o escolhido no seletor da faixa). null fora do Cardápio. */
export function useMenuTenantId(): string | null {
  return useContext(MenuTenantContext);
}

/**
 * Cardápio: barra de ícones, a faixa com as páginas e, ao lado, a página escolhida. No painel master, o seletor no
 * topo da faixa escolhe o restaurante para todas as páginas (o mesmo das Configurações). Desktop no MVP.
 */
export function MenuShell({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const tenants: Tenant[] = (session?.context?.tenants ?? []).filter((t) => t.role === "ADMIN");
  const [tenantId, setTenantId] = useState(() => tenants[0]?.id);
  const tenant = tenants.find((t) => t.id === tenantId) ?? tenants[0];
  if (!tenant) return null;
  return (
    <div className="flex h-full overflow-hidden bg-paper">
      <NavRail />
      <SideMenu title="Cardápio" label="Seções do cardápio" root="/cardapio" nav={NAV} tenants={tenants} tenant={tenant} onTenantChange={setTenantId} />
      <MenuTenantContext value={tenant.id}>
        {/* key: trocar de restaurante remonta a página, sem rascunho de outro restaurante na tela. */}
        <SettingsTenantProvider key={tenant.id} tenant={tenant}>
          {children}
        </SettingsTenantProvider>
      </MenuTenantContext>
    </div>
  );
}

/** As páginas que vieram de Configurações (Cardápio e entrega, Pagamentos, Pedidos pela IA, Vantagens, Meta Ads), na coluna de leitura. */
export function MenuSettingsPage({ wide, children }: { wide?: boolean; children: ReactNode }) {
  return (
    <main className="min-w-0 flex-1 overflow-y-auto px-8 py-7">
      <div className={wide ? "max-w-[1072px]" : "max-w-[760px]"}>{children}</div>
    </main>
  );
}
