"use client";

import { DEFENSE_CATEGORY_LABEL, DEFENSE_REASON_LABEL, type DefenseEventDto } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { StatusBadge } from "@/components/inbox/bits";
import { PlatformHeader, PlatformLoading } from "@/components/platform/platform-header";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useNow } from "@/hooks/use-now";
import { ApiError } from "@/lib/api";
import { dayTime } from "@/lib/format";

const DEFENSE_KEY = ["platform-defense"];

const CONCLUSION_LABEL = { attack: "Ataque confirmado", legitimate: "Uso legítimo", uncertain: "Conclusão incerta" } as const;

/**
 * Defesa da API (Super Admin): os IPs que as regras baniram (sondagem de arquivo sensível, varredura de rotas, abuso
 * de login) e as suspeitas, com a análise do Jev. Mais recentes primeiro.
 */
export function PlatformDefense() {
  const { request } = useAuth();
  const now = useNow(60_000);
  const events = useQuery({
    queryKey: DEFENSE_KEY,
    queryFn: () => request<DefenseEventDto[]>("/platform/defense"),
    // Enquanto o Jev analisa algum caso, a lista se atualiza sozinha.
    refetchInterval: (query) => (query.state.data?.some((event) => event.analysis.state === "pending") ? 5_000 : false),
  });

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
      <PlatformHeader title="Defesa da API" />
      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="max-w-[760px]">
          {events.data ? (
            <section className="overflow-hidden rounded-xl border border-rule">
              <div className="border-b border-rule px-5 pt-4 pb-3.5">
                <h2 className="font-heading text-title font-semibold">IPs banidos e suspeitas</h2>
                <p className="mt-1 text-ink-2">
                  Quem sonda arquivos sensíveis, varre rotas ou insiste no login é banido na hora, com prazo. O Jev analisa cada
                  caso depois: com o ataque confirmado, o banimento passa a 7 dias. A suspeita de abuso de login só é banida aqui.
                  Enquanto a defesa estiver só registrando, os casos aparecem como “Seria banido”: confira se os IPs são de
                  visitantes de verdade antes de ligar o banimento.
                </p>
              </div>
              {events.data.length === 0 ? (
                <p className="px-5 py-6 text-ink-3">Nenhum caso registrado ainda.</p>
              ) : (
                <ul>
                  {events.data.map((event) => (
                    <DefenseRow key={event.id} event={event} now={now} />
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <PlatformLoading failed={events.isError} />
          )}
        </div>
      </div>
    </main>
  );
}

function DefenseRow({ event, now }: { event: DefenseEventDto; now: number }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);

  const act = async (action: "ban" | "unban") => {
    setError(null);
    try {
      const updated = await request<DefenseEventDto>(`/platform/defense/${event.id}/${action}`, { method: "POST" });
      queryClient.setQueryData<DefenseEventDto[]>(DEFENSE_KEY, (list) => list?.map((item) => (item.id === updated.id ? updated : item)));
      toast(action === "ban" ? `${event.ip} foi banido por 7 dias` : `${event.ip} foi desbanido`);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível alterar o banimento.");
    }
  };

  return (
    <li className="border-b border-rule-soft px-5 py-3 last:border-b-0">
      <div className="flex items-center gap-2.5">
        <span className="font-medium tabular-nums">{event.ip}</span>
        <StateBadge event={event} />
        <span className="ml-auto text-[12px] text-ink-3 tabular-nums">{dayTime(event.createdAt, now)}</span>
        {event.active ? (
          <Button variant="outline" size="xs" onClick={() => act("unban")}>
            Desbanir
          </Button>
        ) : (
          <Button variant="destructive" size="xs" onClick={() => act("ban")}>
            Banir por 7 dias
          </Button>
        )}
      </div>
      <p className="mt-1 text-ink-2">
        {DEFENSE_REASON_LABEL[event.reason]} · <span className="tabular-nums">{event.method} {event.path}</span>
        {event.active && event.bannedUntil && <span className="text-ink-3"> · banido até {dayTime(event.bannedUntil, now)}</span>}
      </p>
      <p className="mt-1 text-[12px] text-ink-3">
        <Analysis analysis={event.analysis} />
      </p>
      {event.userAgent && <p className="mt-0.5 truncate text-[12px] text-ink-3">{event.userAgent}</p>}
      {error && (
        <p role="alert" className="mt-1 text-xs text-tomate">
          {error}
        </p>
      )}
    </li>
  );
}

function StateBadge({ event }: { event: DefenseEventDto }) {
  if (event.active) return <StatusBadge tone="open">IP banido</StatusBadge>;
  if (event.unbannedAt) return <StatusBadge tone="neutral">Desbanido</StatusBadge>;
  if (event.action === "suspected") return <StatusBadge tone="pending">Suspeita</StatusBadge>;
  if (event.action === "watched") {
    return (
      <StatusBadge tone="pending" title="A regra baniria este IP, mas a defesa está só registrando (DEFENSE_MODE=watch).">
        Seria banido
      </StatusBadge>
    );
  }
  return <StatusBadge tone="neutral">Banimento expirado</StatusBadge>;
}

function Analysis({ analysis }: { analysis: DefenseEventDto["analysis"] }) {
  if (analysis.state === "off") return <>Análise do Jev desligada (falta a JEV_API_KEY).</>;
  if (analysis.state === "pending") return <>O Jev está analisando…</>;
  if (analysis.state === "failed") return <>O Jev não respondeu. A regra continua valendo.</>;
  return (
    <>
      Jev: {analysis.category ? DEFENSE_CATEGORY_LABEL[analysis.category] : "sem categoria"} ·{" "}
      <span className={analysis.conclusion === "attack" ? "font-medium text-tomate" : undefined}>
        {CONCLUSION_LABEL[analysis.conclusion]}
      </span>
      {analysis.attack !== null && <span className="tabular-nums"> · {Math.round(analysis.attack * 100)}% de chance de ataque</span>}
      {analysis.reused && " · conclusão reaproveitada de um caso igual"}
    </>
  );
}
