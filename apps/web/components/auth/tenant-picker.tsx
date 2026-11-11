"use client";

import type { AuthContext } from "@dishdesk/shared";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type Tenant = AuthContext["tenants"][number];

/**
 * Painel master: o restaurante que a tela mostra e altera (Configurações, Avaliações). Com um só, não aparece.
 * `onSelectAll`: oferece "Todos os restaurantes" no topo (`tenant` null = todos escolhidos).
 */
export function TenantPicker({
  tenants,
  tenant,
  onChange,
  onSelectAll,
}: {
  tenants: Tenant[];
  tenant: Tenant | null;
  onChange: (tenantId: string) => void;
  onSelectAll?: () => void;
}) {
  if (tenants.length < 2) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Escolher o restaurante" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "max-w-full gap-1.5")}>
        <span className="font-normal text-ink-3">Restaurante</span>
        <span className="truncate">{tenant?.name ?? "Todos"}</span>
        <ChevronDownIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        {onSelectAll && (
          <DropdownMenuItem onClick={onSelectAll}>
            <span className="flex-1">Todos os restaurantes</span>
            {!tenant && <CheckIcon className="size-3.5" aria-hidden />}
          </DropdownMenuItem>
        )}
        {tenants.map((item) => (
          <DropdownMenuItem key={item.id} onClick={() => onChange(item.id)}>
            <span className="flex-1">{item.name}</span>
            {item.id === tenant?.id && <CheckIcon className="size-3.5" aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
