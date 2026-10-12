"use client";

import { TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/components/auth/auth-provider";
import { useNow } from "@/hooks/use-now";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Lembrete no topo do painel enquanto o acesso está liberado por confiança (assinatura vencida): quem atende avisa
 * quem paga. O design ainda não tem este aviso: segue as cores de alerta (âmbar) do Sistema de Design. Desktop no MVP.
 */
export function TrustReminder() {
  const { session } = useAuth();
  const now = useNow(60_000);
  const context = session?.context;
  if (!context) return null;

  const pending = context.tenants.flatMap((tenant) => {
    const trustUntil = session.tenants.find((t) => t.id === tenant.id)?.billing?.trustUntil;
    return trustUntil ? [{ ...tenant, daysLeft: Math.max(1, Math.ceil((new Date(trustUntil).getTime() - now) / DAY_MS)) }] : [];
  });
  if (pending.length === 0) return null;

  return (
    <div role="status" className="flex shrink-0 flex-col gap-1 border-b border-warning-line bg-warning-lt px-4 py-2 text-xs text-warning-ink">
      {pending.map((tenant) => (
        <p key={tenant.id} className="flex items-center justify-center gap-2">
          <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />
          <span>
            {context.tenants.length > 1 && <span className="font-medium">{tenant.name}: </span>}
            Avise ao financeiro para concluir o pagamento.{" "}
            <span className="font-medium tabular-nums">{tenant.daysLeft === 1 ? "1 dia restante" : `${tenant.daysLeft} dias restantes`}</span>.
          </span>
          {tenant.role === "ADMIN" && (
            <Link href="/configuracoes/pagamento" className="font-medium underline underline-offset-2">
              Concluir pagamento
            </Link>
          )}
        </p>
      ))}
    </div>
  );
}
