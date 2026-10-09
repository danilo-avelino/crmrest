"use client";

import type { ConversationCounts, ConversationListItem, ConversationPage } from "@dishdesk/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { BellRingIcon, CheckIcon, ListFilterIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Avatar, StatusBadge } from "@/components/inbox/bits";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgentAlarm } from "@/hooks/use-agent-alarm";
import { useNow } from "@/hooks/use-now";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

// A primeira aba mostra só o que a equipe ainda precisa tratar; as resolvidas ficam na aba delas.
type StatusFilter = "ACTIVE" | "OPEN" | "PENDING" | "RESOLVED";
const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "ACTIVE", label: "Ativos" },
  { value: "OPEN", label: "Abertos" },
  { value: "PENDING", label: "Pendentes" },
  { value: "RESOLVED", label: "Resolvidos" },
];

/** Lista de conversas (coluna de 320px do board Inbox). */
export function ConversationList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { request, session } = useAuth();
  const master = session?.context?.mode === "master";
  const [status, setStatus] = useState<StatusFilter>("ACTIVE");
  const [search, setSearch] = useState("");
  const [tenantId, setTenantId] = useState<string | null>(null);
  const term = useDebounced(search.trim(), 300);
  const now = useNow();

  const query = (extra: Record<string, string | null>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ tenantId, ...extra })) if (value) params.set(key, value);
    return params.toString();
  };

  const conversations = useInfiniteQuery({
    queryKey: ["conversations", { status, term, tenantId }],
    queryFn: ({ pageParam }) =>
      request<ConversationPage>(
        `/conversations?${query({ status, search: term || null, cursor: pageParam })}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
  const counts = useQuery({
    queryKey: ["counts", tenantId],
    queryFn: () => request<ConversationCounts>(`/conversations/counts?${query({})}`),
  });

  // O alarme vale para todos os restaurantes do usuário, mesmo com a lista filtrada por um deles.
  const allCounts = useQuery({
    queryKey: ["counts", null],
    queryFn: () => request<ConversationCounts>("/conversations/counts"),
  });
  const calling = allCounts.data?.awaitingAgent ?? 0;
  const alarm = useAgentAlarm(calling > 0);

  const items = conversations.data?.pages.flatMap((page) => page.items) ?? [];
  useUnreadSignals(items, calling);

  return (
    <section className="flex w-80 shrink-0 flex-col border-r border-rule bg-surface">
      <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-rule px-4">
        <h2 className="font-heading text-[16px] font-bold tracking-[-0.3px]">Inbox</h2>
        {master && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Filtrar por restaurante"
              className={cn(
                "flex size-7 items-center justify-center rounded-md border bg-paper",
                tenantId ? "border-ink" : "border-rule",
              )}
            >
              <ListFilterIcon className="size-3.5 text-ink-2" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {[{ id: null, name: "Todos os restaurantes" }, ...(session?.context?.tenants ?? [])].map((tenant) => (
                <DropdownMenuItem key={tenant.id ?? "all"} onClick={() => setTenantId(tenant.id)}>
                  <span className="flex-1">{tenant.name}</span>
                  {tenantId === tenant.id && <CheckIcon className="size-3.5" aria-hidden />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>

      {calling > 0 && (
        <div role="alert" className="flex shrink-0 items-center gap-2 bg-tomate px-4 py-2 text-[12px] font-semibold text-white">
          <BellRingIcon className="size-4 shrink-0 animate-bounce" aria-hidden />
          <span className="flex-1">
            {calling === 1 ? "1 cliente chamando um atendente" : `${calling} clientes chamando um atendente`}
            {alarm.blocked && <span className="block text-[10.5px] font-normal opacity-90">Clique na página para ativar o som.</span>}
          </span>
        </div>
      )}

      <div className="shrink-0 border-b border-rule px-3 py-2.5">
        <label className="flex h-8 items-center gap-2 rounded-md border border-rule bg-paper px-2.5 focus-within:border-ink">
          <SearchIcon className="size-3.5 shrink-0 text-ink-3" aria-hidden />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar conversa..."
            aria-label="Buscar conversa por nome, telefone ou CPF"
            className="w-full bg-transparent text-[12px] outline-none placeholder:text-ink-3"
          />
        </label>
      </div>

      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-rule px-3 py-2">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            aria-pressed={status === filter.value}
            onClick={() => setStatus(filter.value)}
            className={cn(
              "rounded-sm px-2.5 py-1 text-[11px] whitespace-nowrap",
              status === filter.value ? "bg-ink font-medium text-paper" : "border border-rule text-ink-2 hover:bg-surface-2",
            )}
          >
            {filter.label}
            {filter.value === "OPEN" && (counts.data?.OPEN ?? 0) > 0 && (
              <span className="ml-1 rounded-full bg-tomate px-[5px] text-[9.5px] text-white tabular-nums">
                {counts.data?.OPEN}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto">
        {conversations.isPending ? (
          <ListSkeleton />
        ) : conversations.isError ? (
          <div className="flex flex-col items-center gap-3 p-6 text-center text-[12px] text-ink-3">
            Não foi possível carregar as conversas.
            <Button variant="outline" size="sm" onClick={() => conversations.refetch()}>
              Tentar de novo
            </Button>
          </div>
        ) : items.length === 0 ? (
          <p className="p-6 text-center text-[12px] text-ink-3">
            {term ? "Nenhuma conversa encontrada." : "Nenhuma conversa por aqui."}
          </p>
        ) : (
          <>
            {items.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === selectedId}
                showTenant={master}
                now={now}
                onSelect={() => onSelect(conversation.id)}
              />
            ))}
            {conversations.hasNextPage && (
              <div className="p-3 text-center">
                <Button variant="ghost" size="sm" onClick={() => conversations.fetchNextPage()}>
                  Carregar mais
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ConversationRow({
  conversation,
  active,
  showTenant,
  now,
  onSelect,
}: {
  conversation: ConversationListItem;
  active: boolean;
  showTenant: boolean;
  now: number;
  onSelect: () => void;
}) {
  const unread = conversation.unreadCount > 0;
  const resolved = conversation.status === "RESOLVED";
  const calling = conversation.awaitingAgentSince !== null;
  const time = conversation.lastMessageAt ?? conversation.createdAt;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full shrink-0 gap-2.5 border-b border-l-2 px-3.5 py-3 text-left",
        active
          ? "border-b-[#F5C4BC] border-l-tomate bg-tomate-lt"
          : "border-b-rule-soft border-l-transparent bg-surface hover:bg-paper",
        // Chamando o atendente: borda grossa e fundo tomate, para saltar aos olhos.
        calling && "border-l-4 border-l-tomate bg-tomate-lt hover:bg-tomate-lt",
        resolved && !active && "opacity-60",
      )}
    >
      <Avatar
        seed={conversation.contact.id}
        name={conversation.contact.name}
        channel={conversation.channel.type}
        className="size-9 text-[12px]"
        ringClassName={active ? "border-tomate-lt" : undefined}
      />
      <div className="min-w-0 flex-1">
        {calling && (
          <div className="mb-1 inline-flex animate-pulse items-center gap-1 rounded-sm bg-tomate px-1.5 py-0.5 text-[10px] font-semibold text-white">
            <BellRingIcon className="size-3" aria-hidden />
            Chamando atendente · {ago(conversation.awaitingAgentSince!, now)}
          </div>
        )}
        <div className="mb-0.5 flex items-baseline justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={cn("truncate text-[13px]", unread || active ? "font-semibold" : resolved ? "text-ink-2" : "")}>
              {conversation.contact.name ?? "Cliente sem nome"}
            </span>
            {conversation.status === "PENDING" && <StatusBadge tone="pending">Pendente</StatusBadge>}
            {resolved && <StatusBadge tone="resolved">Resolvida</StatusBadge>}
            {conversation.contact.phoneStatus === "pending" && (
              <StatusBadge tone="pending" title="Telefone pendente">
                ⚠
              </StatusBadge>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-[5px]">
            <span className={cn("text-[10px] tabular-nums", unread ? "font-semibold text-tomate" : "text-ink-3")}>
              {ago(time, now)}
            </span>
            {unread && (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-tomate px-[3px] text-[9px] font-bold text-white tabular-nums">
                {conversation.unreadCount}
              </span>
            )}
          </div>
        </div>
        {showTenant && <div className="text-[10px] text-ink-3">{conversation.tenant.name}</div>}
        <div className={cn("truncate text-[11.5px]", unread ? "font-medium text-ink" : active ? "text-ink-2" : "text-ink-3")}>
          {conversation.lastMessage?.preview ?? ""}
        </div>
      </div>
    </button>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy aria-label="Carregando conversas">
      {[55, 40, 62].map((width, index) => (
        <div key={index} className="flex items-start gap-2.5 border-b border-rule-soft px-3.5 py-3" style={{ opacity: 1 - index * 0.25 }}>
          <div className="size-9 rounded-full bg-rule-soft" />
          <div className="flex flex-1 flex-col gap-1.5 pt-0.5">
            <div className="h-[11px] rounded-[3px] bg-rule-soft" style={{ width: `${width}%` }} />
            <div className="h-2.5 w-[85%] rounded-[3px] bg-surface-2" />
          </div>
        </div>
      ))}
    </div>
  );
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Nova mensagem: número de não lidas no título da aba e um aviso sonoro curto (o alarme de chamado tem o próprio som). */
function useUnreadSignals(items: ConversationListItem[], calling: number) {
  const total = items.reduce((sum, conversation) => sum + conversation.unreadCount, 0);
  const previous = useRef<number | null>(null);
  useEffect(() => {
    const title = total > 0 ? `(${total}) Dish Desk` : "Dish Desk";
    document.title = calling > 0 ? `🔔 Chamando atendente · ${title}` : title;
    if (previous.current !== null && total > previous.current && calling === 0) beep();
    previous.current = total;
  }, [total, calling]);
}

function beep() {
  try {
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.25);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.onended = () => void audio.close();
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.25);
  } catch {
    // Sem áudio disponível (ou bloqueado pelo navegador): o título da aba ainda avisa.
  }
}
