"use client";

import type { PlatformAuditDto } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/components/auth/auth-provider";
import { PlatformHeader, PlatformLoading } from "@/components/platform/platform-header";
import { useNow } from "@/hooks/use-now";
import { dayTime } from "@/lib/format";

const ACTION_LABEL: Record<PlatformAuditDto["action"], string> = {
  "tenant.create": "Criou o restaurante",
  "tenant.suspend": "Suspendeu o restaurante",
  "tenant.reactivate": "Reativou o restaurante",
  "tenant.support_access": "Entrou como suporte em",
};

/** Auditoria da plataforma (Super Admin, E16): criação, suspensão e acessos de suporte, mais recentes primeiro. */
export function PlatformAudit() {
  const { request } = useAuth();
  const now = useNow(60_000);
  const audit = useQuery({ queryKey: ["platform-audit"], queryFn: () => request<PlatformAuditDto[]>("/platform/audit") });

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
      <PlatformHeader title="Auditoria" />
      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="max-w-[760px]">
          {audit.data ? (
            <section className="overflow-hidden rounded-xl border border-rule">
              <div className="border-b border-rule px-5 pt-4 pb-3.5">
                <h2 className="font-heading text-title font-semibold">Ações da plataforma</h2>
                <p className="mt-1 text-ink-2">
                  Tudo o que a equipe da plataforma faz nos restaurantes fica registrado aqui. Os restaurantes não veem este
                  histórico.
                </p>
              </div>
              {audit.data.length === 0 ? (
                <p className="px-5 py-6 text-ink-3">Nenhuma ação registrada ainda.</p>
              ) : (
                <ul>
                  {audit.data.map((entry) => (
                    <li key={entry.id} className="flex items-baseline gap-3 border-b border-rule-soft px-5 py-2.5 last:border-b-0">
                      <span className="w-28 shrink-0 text-[12px] text-ink-3 tabular-nums">{dayTime(entry.createdAt, now)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{entry.userName ?? "Usuário removido"}</span>{" "}
                        <span className="text-ink-2">{ACTION_LABEL[entry.action] ?? entry.action}</span>{" "}
                        <span className="font-medium">{entry.tenantName ?? "restaurante removido"}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <PlatformLoading failed={audit.isError} />
          )}
        </div>
      </div>
    </main>
  );
}
