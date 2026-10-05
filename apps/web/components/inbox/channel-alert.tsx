"use client";

import { CHANNEL_LABEL, type ChannelHealthDto } from "@comanda/shared";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/components/auth/auth-provider";

/** Faixa no topo da Inbox quando um canal precisa ser reconectado (token vencido ou revogado). */
export function ChannelAlert() {
  const { request, session } = useAuth();
  const channels = useQuery({
    queryKey: ["channels"],
    queryFn: () => request<ChannelHealthDto[]>("/channels"),
    refetchInterval: 60_000,
  });
  const broken = channels.data?.filter((channel) => channel.status !== "CONNECTED") ?? [];
  if (broken.length === 0) return null;
  const tenants = session?.context?.tenants ?? [];

  return (
    <div role="alert" className="shrink-0 border-b border-tomate-line bg-tomate-lt px-4 py-2">
      {broken.map((channel) => {
        const tenant = tenants.find((item) => item.id === channel.tenantId);
        const admin = tenant?.role === "ADMIN";
        const label = CHANNEL_LABEL[channel.type];
        return (
          <p key={channel.id} className="flex items-center gap-2 text-xs text-tomate-ink">
            <TriangleAlertIcon className="size-3.5 shrink-0 text-tomate" aria-hidden />
            <span>
              <strong className="font-medium">
                {label}
                {channel.name !== label && ` · ${channel.name}`}
                {tenants.length > 1 && tenant && ` (${tenant.name})`}
              </strong>{" "}
              está desconectado: as respostas por este canal não estão saindo.
            </span>
            {admin ? (
              <Link href="/configuracoes/integracoes" className="font-medium text-tomate underline underline-offset-2">
                Reconectar
              </Link>
            ) : (
              <span className="text-tomate-ink/80">Avise um administrador do restaurante.</span>
            )}
          </p>
        );
      })}
    </div>
  );
}
