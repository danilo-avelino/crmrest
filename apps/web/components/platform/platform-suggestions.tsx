"use client";

import { type PlatformSuggestionDto, SUGGESTION_SUBJECTS, type SuggestionSubject } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { PlatformHeader, PlatformLoading } from "@/components/platform/platform-header";
import { useNow } from "@/hooks/use-now";
import { dayTime } from "@/lib/format";

type Group = { subject: SuggestionSubject | null; items: PlatformSuggestionDto[] };

/** Assuntos com mais sugestões primeiro; as ainda sem assunto (IA fora do ar) por último. */
function ranking(suggestions: PlatformSuggestionDto[]): Group[] {
  const groups = new Map<SuggestionSubject | null, PlatformSuggestionDto[]>();
  for (const item of suggestions) groups.set(item.subject, [...(groups.get(item.subject) ?? []), item]);
  return [...groups.entries()]
    .map(([subject, items]) => ({ subject, items }))
    .sort((a, b) => (a.subject === null ? 1 : b.subject === null ? -1 : b.items.length - a.items.length));
}

/** Sugestões dos restaurantes (painel da extensão), agrupadas por assunto e ranqueadas pela quantidade. */
export function PlatformSuggestions() {
  const { request } = useAuth();
  const now = useNow(60_000);
  const suggestions = useQuery({
    queryKey: ["platform-suggestions"],
    queryFn: () => request<PlatformSuggestionDto[]>("/platform/suggestions"),
  });
  const groups = suggestions.data ? ranking(suggestions.data) : [];
  const top = Math.max(1, ...groups.map((group) => group.items.length));

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
      <PlatformHeader title="Sugestões" />
      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="max-w-[760px]">
          {suggestions.data ? (
            <section className="overflow-hidden rounded-xl border border-rule">
              <div className="border-b border-rule px-5 pt-4 pb-3.5">
                <h2 className="font-heading text-title font-semibold">Ranking por assunto</h2>
                <p className="mt-1 text-ink-2">
                  O que os restaurantes sugerem pelo assistente da extensão, depois de terminar a implantação. A IA classifica o
                  assunto de cada sugestão.
                </p>
              </div>
              {groups.length === 0 ? (
                <p className="px-5 py-6 text-ink-3">Nenhuma sugestão ainda.</p>
              ) : (
                <ol>
                  {groups.map((group, index) => (
                    <SubjectRow key={group.subject ?? "none"} group={group} position={index + 1} top={top} now={now} />
                  ))}
                </ol>
              )}
            </section>
          ) : (
            <PlatformLoading failed={suggestions.isError} />
          )}
        </div>
      </div>
    </main>
  );
}

function SubjectRow({ group, position, top, now }: { group: Group; position: number; top: number; now: number }) {
  const [open, setOpen] = useState(false);
  const label = group.subject ? SUGGESTION_SUBJECTS[group.subject] : "Sem assunto (a IA não classificou)";
  return (
    <li className="border-b border-rule-soft last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-paper"
      >
        <span className="w-6 shrink-0 text-[12px] text-ink-3 tabular-nums">{group.subject ? `${position}º` : "–"}</span>
        <span className="w-52 shrink-0 truncate font-medium">{label}</span>
        <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
          <span className="block h-full rounded-full bg-tomate" style={{ width: `${(group.items.length / top) * 100}%` }} />
        </span>
        <span className="w-20 shrink-0 text-right text-ink-2 tabular-nums">
          {group.items.length} {group.items.length === 1 ? "sugestão" : "sugestões"}
        </span>
        {open ? <ChevronUpIcon className="size-4 text-ink-3" aria-hidden /> : <ChevronDownIcon className="size-4 text-ink-3" aria-hidden />}
      </button>
      {open && (
        <ul className="border-t border-rule-soft bg-paper/60">
          {group.items.map((item) => (
            <li key={item.id} className="border-b border-rule-soft px-5 py-2.5 pl-14 last:border-b-0">
              <p className="whitespace-pre-wrap">{item.text}</p>
              <p className="mt-0.5 text-[12px] text-ink-3">
                {item.userName} · {item.tenantName} · <span className="tabular-nums">{dayTime(item.createdAt, now)}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
