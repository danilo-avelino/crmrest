"use client";

import {
  Building2Icon,
  ChartColumnIcon,
  CoinsIcon,
  LightbulbIcon,
  ScrollTextIcon,
  ShieldIcon,
  TicketIcon,
} from "lucide-react";
import { SideMenu, type SideMenuGroup } from "@/components/layout/side-menu";

/** O menu do painel da plataforma, em grupos. A primeira página (/plataforma) é a lista de restaurantes. */
const NAV: SideMenuGroup[] = [
  {
    group: "Restaurantes",
    items: [
      { href: "/plataforma", label: "Restaurantes", icon: Building2Icon },
      { href: "/plataforma/tickets", label: "Tickets de suporte", icon: TicketIcon },
      { href: "/plataforma/sugestoes", label: "Sugestões", icon: LightbulbIcon },
    ],
  },
  {
    group: "Uso",
    items: [
      { href: "/plataforma/trafego", label: "Tráfego do site", icon: ChartColumnIcon },
      { href: "/plataforma/ia", label: "Gastos com IA", icon: CoinsIcon },
    ],
  },
  {
    group: "Segurança",
    items: [
      { href: "/plataforma/seguranca", label: "Defesa da API", icon: ShieldIcon },
      { href: "/plataforma/auditoria", label: "Auditoria", icon: ScrollTextIcon },
    ],
  },
];

/** Menu lateral do painel da plataforma, no mesmo desenho do menu de Configurações. */
export function PlatformMenu() {
  return <SideMenu title="Plataforma" subtitle="Super Admin" label="Páginas da plataforma" root="/plataforma" nav={NAV} />;
}
