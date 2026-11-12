"use client";

import type { AuthContext } from "@dishdesk/shared";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { TenantPicker } from "@/components/auth/tenant-picker";
import { cn } from "@/lib/utils";

type Tenant = AuthContext["tenants"][number];

export type SideMenuGroup = { group: string; items: { href: string; label: string; icon: LucideIcon }[] };

/**
 * Menu lateral em grupos (Configurações, Avaliações e Plataforma): o título da área, o restaurante e as páginas. No
 * painel master, o seletor no topo escolhe o restaurante para todas as páginas. `root`: a primeira página, ativa só no
 * endereço exato. Sem restaurantes (Plataforma), mostra `subtitle` embaixo do título.
 */
export function SideMenu({
  title,
  subtitle,
  label,
  root,
  nav,
  tenants = [],
  tenant = null,
  onTenantChange,
  onSelectAll,
}: {
  title: string;
  /** Texto embaixo do título quando não há seletor de restaurante. */
  subtitle?: string;
  /** Nome do menu para leitores de tela. */
  label: string;
  root: string;
  nav: SideMenuGroup[];
  tenants?: Tenant[];
  /** null = todos os restaurantes (só com `onSelectAll`). */
  tenant?: Tenant | null;
  onTenantChange?: (tenantId: string) => void;
  /** Oferece "Todos os restaurantes" no seletor. */
  onSelectAll?: () => void;
}) {
  const pathname = usePathname();
  return (
    <aside className="flex w-[236px] shrink-0 flex-col overflow-y-auto border-r border-rule bg-surface">
      <div className="px-5 pt-5 pb-4">
        <p className="font-heading text-[21px] font-bold tracking-[-0.3px]">{title}</p>
        {tenants.length > 1 && onTenantChange ? (
          <div className="mt-2.5">
            <TenantPicker tenants={tenants} tenant={tenant} onChange={onTenantChange} onSelectAll={onSelectAll} />
          </div>
        ) : (
          <p className="mt-[3px] truncate text-[12px] text-ink-3">{subtitle ?? tenant?.name}</p>
        )}
      </div>
      <nav aria-label={label} className="pb-5">
        {nav.map(({ group, items }) => (
          <div key={group} className="mb-3">
            <p className="mb-1 px-5 pt-1 text-[10px] font-semibold tracking-[0.1em] text-ink-3 uppercase">{group}</p>
            <ul>
              {items.map(({ href, label: item, icon: Icon }) => {
                const active = href === root ? pathname === href : pathname.startsWith(href);
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2.5 border-l-[3px] py-2 pr-4 pl-[17px] text-[13px]",
                        active ? "border-tomate bg-tomate-lt font-medium text-ink" : "border-transparent text-ink-2 hover:bg-paper",
                      )}
                    >
                      <Icon className={cn("size-4 shrink-0", active ? "text-tomate" : "text-ink-3")} aria-hidden />
                      {item}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
