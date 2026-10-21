"use client";

import { CHANNEL_LABEL, type ChannelHealthDto, tokenExpiryLabel, tokenExpiryWarning } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/components/auth/auth-provider";

/**
 * Faixa no topo da Inbox quando um canal precisa ser reconectado (token vencido ou revogado), em tomate, ou quando o
 * token está para vencer e a renovação automática falhou, em âmbar.
 */
export function ChannelAlert() {
  const { request, session } = useAuth();
  const channels = useQuery({
    queryKey: ["channels"],
    queryFn: () => request<ChannelHealthDto[]>("/channels"),
    refetchInterval: 60_000,
  });
  const broken = channels.data?.filter((channel) => channel.status !== "CONNECTED") ?? [];
  const expiring = (channels.data ?? [])
    .filter((channel) => channel.status === "CONNECTED")
    .map((channel) => ({ channel, days: tokenExpiryWarning(channel.tokenExpiresAt) }))
    .filter((item): item is { channel: ChannelHealthDto; days: number } => item.days !== null);
  if (broken.length === 0 && expiring.length === 0) return null;
  const tenants = session?.context?.tenants ?? [];

  const line = (channel: ChannelHealthDto, message: string, tone: "tomate" | "warning") => {
    const tenant = tenants.find((item) => item.id === channel.tenantId);
    const admin = tenant?.role === "ADMIN";
    const label = CHANNEL_LABEL[channel.type];
    return (
      <p key={channel.id} className={tone === "tomate" ? "flex items-center gap-2 text-xs text-tomate-ink" : "flex items-center gap-2 text-xs text-warning-ink"}>
        <TriangleAlertIcon className={tone === "tomate" ? "size-3.5 shrink-0 text-tomate" : "size-3.5 shrink-0 text-warning"} aria-hidden />
        <span>
          <strong className="font-medium">
            {label}
            {channel.name !== label && ` · ${channel.name}`}
            {tenants.length > 1 && tenant && ` (${tenant.name})`}
          </strong>{" "}
          {message}
        </span>
        {admin ? (
          <Link
            href="/configuracoes/integracoes"
            className={tone === "tomate" ? "font-medium text-tomate underline underline-offset-2" : "font-medium text-warning-ink underline underline-offset-2"}
          >
            Reconectar
          </Link>
        ) : (
          <span className={tone === "tomate" ? "text-tomate-ink/80" : "text-warning-ink/80"}>Avise um administrador do restaurante.</span>
        )}
      </p>
    );
  };

  return (
    <>
      {broken.length > 0 && (
        <div role="alert" className="shrink-0 border-b border-tomate-line bg-tomate-lt px-4 py-2">
          {broken.map((channel) => line(channel, "está desconectado: as respostas por este canal não estão saindo.", "tomate"))}
        </div>
      )}
      {expiring.length > 0 && (
        <div role="status" className="shrink-0 border-b border-warning-line bg-warning-lt px-4 py-2">
          {expiring.map(({ channel, days }) =>
            line(
              channel,
              `precisa ser conectado de novo: o acesso ${tokenExpiryLabel(days).toLowerCase()} e a renovação automática não funcionou.`,
              "warning",
            ),
          )}
        </div>
      )}
    </>
  );
}
