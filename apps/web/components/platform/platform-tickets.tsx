"use client";

import { formatPhone, type PlatformTicketDto } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/components/auth/auth-provider";
import { PlatformHeader, PlatformLoading } from "@/components/platform/platform-header";
import { useNow } from "@/hooks/use-now";
import { dayTime } from "@/lib/format";

/** Tickets ao suporte (painel da extensão, quando a IA não resolve), dos mais recentes aos mais antigos. */
export function PlatformTickets() {
  const { request } = useAuth();
  const now = useNow(60_000);
  const tickets = useQuery({
    queryKey: ["platform-tickets"],
    queryFn: () => request<PlatformTicketDto[]>("/platform/tickets"),
  });

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
      <PlatformHeader title="Tickets de suporte" />
      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="max-w-[760px]">
          {tickets.data ? (
            <section className="overflow-hidden rounded-xl border border-rule">
              <div className="border-b border-rule px-5 pt-4 pb-3.5">
                <h2 className="font-heading text-title font-semibold">Para entrar em contato</h2>
                <p className="mt-1 text-ink-2">O que o assistente da extensão não resolveu. A IA resume o problema de cada ticket.</p>
              </div>
              {tickets.data.length === 0 ? (
                <p className="px-5 py-6 text-ink-3">Nenhum ticket ainda.</p>
              ) : (
                <ul>
                  {tickets.data.map((ticket) => (
                    <li key={ticket.id} className="border-b border-rule-soft px-5 py-3 last:border-b-0">
                      <p className="font-medium">
                        {ticket.name} · <span className="tabular-nums">{formatPhone(ticket.phone)}</span>
                      </p>
                      <p className="mt-1 whitespace-pre-wrap text-ink-2">{ticket.summary}</p>
                      <p className="mt-1 text-[12px] text-ink-3">
                        {ticket.tenantName} · conta de {ticket.userName} · <span className="tabular-nums">{dayTime(ticket.createdAt, now)}</span>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <PlatformLoading failed={tickets.isError} />
          )}
        </div>
      </div>
    </main>
  );
}
