"use client";

import { CHANNEL_LABEL, type DuplicatePair } from "@comanda/shared";
import { useQuery } from "@tanstack/react-query";
import { UserIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { CHANNEL_DOT } from "@/components/inbox/bits";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

type ChannelType = keyof typeof CHANNEL_LABEL;

// Avatares do board Clientes: fundo escuro e iniciais em Fraunces.
const AVATAR_COLORS = ["bg-tomate", "bg-[#2A3D55]", "bg-[#3D2A45]", "bg-[#2D4535]", "bg-[#3A2A1A]"];

export function ClientAvatar({
  seed,
  name,
  anonymized = false,
  className,
}: {
  seed: string;
  name: string | null;
  anonymized?: boolean;
  className?: string;
}) {
  if (anonymized) {
    return (
      <div className={cn("flex shrink-0 items-center justify-center rounded-full bg-rule text-ink-3", className)}>
        <UserIcon className="size-[42%]" aria-hidden />
      </div>
    );
  }
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-heading font-bold text-white",
        AVATAR_COLORS[hash % AVATAR_COLORS.length],
        className,
      )}
    >
      {initials(name)}
    </div>
  );
}

export function ChannelDots({ channels, className }: { channels: ChannelType[]; className?: string }) {
  return (
    <div className="flex items-center gap-[5px]">
      {channels.map((channel) => (
        <span
          key={channel}
          title={CHANNEL_LABEL[channel]}
          className={cn("size-2 shrink-0 rounded-full", CHANNEL_DOT[channel], className)}
        />
      ))}
    </div>
  );
}

/** Título de seção em caixa alta (cadastro e métricas do detalhe). */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-2.5 text-[10.5px] font-medium tracking-[0.07em] text-ink-3 uppercase", className)}>{children}</div>
  );
}

/** Selo âmbar "possível duplicado". */
export function DuplicateBadge() {
  return (
    <span className="rounded-[3px] border border-[#FDE68A] bg-[#FEF3C7] px-[5px] py-px text-[10px] font-medium whitespace-nowrap text-[#92400E]">
      possível duplicado
    </span>
  );
}

// Volta do detalhe para a lista com a mesma busca e os mesmos filtros (vale durante a sessão de navegação).
let listHref = "/clientes";
export function rememberListHref(href: string) {
  listHref = href;
}
export function lastListHref() {
  return listHref;
}

/** O usuário é admin do restaurante (unir, exportar e anonimizar são só do admin). */
export function useIsAdmin(tenantId?: string): boolean {
  const { session } = useAuth();
  const tenants = session?.context?.tenants ?? [];
  return tenants.some((tenant) => tenant.role === "ADMIN" && (!tenantId || tenant.id === tenantId));
}

/** Fila de possíveis duplicados; só é buscada para admins. */
export function useDuplicates() {
  const { request } = useAuth();
  const admin = useIsAdmin();
  return useQuery({
    queryKey: ["contact-duplicates"],
    queryFn: () => request<DuplicatePair[]>("/contacts/duplicates"),
    enabled: admin,
  });
}
