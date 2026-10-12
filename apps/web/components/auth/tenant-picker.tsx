"use client";

import type { AuthContext } from "@dishdesk/shared";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type Tenant = AuthContext["tenants"][number];

/** Painel master: o restaurante que a tela mostra e altera (Configurações, Avaliações). Com um só, não aparece. */
export function TenantPicker({ tenants, tenant, onChange }: { tenants: Tenant[]; tenant: Tenant; onChange: (tenantId: string) => void }) {
  if (tenants.length < 2) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Escolher o restaurante" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}>
        <span className="font-normal text-ink-3">Restaurante</span>
        {tenant.name}
        <ChevronDownIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        {tenants.map((item) => (
          <DropdownMenuItem key={item.id} onClick={() => onChange(item.id)}>
            <span className="flex-1">{item.name}</span>
            {item.id === tenant.id && <CheckIcon className="size-3.5" aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
