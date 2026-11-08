"use client";

import type { TenantSettingsDto } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import { PauseCircleIcon } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/components/auth/auth-provider";

/**
 * Faixa âmbar no topo da Inbox enquanto o Dish Desk está pausado (Configurações → Pausa): sem automações nem IA, as
 * mensagens só chegam. O administrador retoma por lá; o atendente é orientado a avisá-lo.
 */
export function PauseAlert() {
  const { request } = useAuth();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => request<TenantSettingsDto[]>("/settings"),
    refetchInterval: 60_000,
  });
  const paused = settings.data?.filter((item) => item.paused) ?? [];
  if (paused.length === 0) return null;
  const several = (settings.data?.length ?? 0) > 1;

  return (
    <div role="status" className="shrink-0 border-b border-warning-line bg-warning-lt px-4 py-2">
      {paused.map((item) => (
        <p key={item.tenantId} className="flex items-center gap-2 text-xs text-warning-ink">
          <PauseCircleIcon className="size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            <strong className="font-medium">Dish Desk pausado{several && ` (${item.tenantName})`}:</strong> nenhuma automação nem a IA
            estão respondendo. As mensagens chegam e esperam a equipe.
          </span>
          {item.canEdit ? (
            <Link href="/configuracoes/pausa" className="font-medium text-warning-ink underline underline-offset-2">
              Retomar em Configurações
            </Link>
          ) : (
            <span className="text-warning-ink/80">Avise um administrador do restaurante.</span>
          )}
        </p>
      ))}
    </div>
  );
}
