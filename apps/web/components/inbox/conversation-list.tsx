"use client";

import { type ConversationCounts, type ConversationListItem, type ConversationPage, COURIER_TAG } from "@dishdesk/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { BellIcon, BellRingIcon, BikeIcon, CheckIcon, ChevronDownIcon, ClockIcon, CornerUpLeftIcon, SearchIcon, StoreIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Avatar, StatusBadge, TeamOnlyBadge } from "@/components/inbox/bits";
import { FraudBadge } from "@/components/orders/fraud-alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgentAlarm } from "@/hooks/use-agent-alarm";
import { useNow } from "@/hooks/use-now";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

// A primeira aba mostra só o que a equipe ainda precisa tratar (com os filtros Todos, Abertos e Pendentes); as que só
// tiveram automação (sem chamar a equipe) ficam em Automáticos e as resolvidas, na aba delas.
type Tab = "ACTIVE" | "AUTO" | "RESOLVED";
type Sub = "ALL" | "OPEN" | "PENDING";
/** Aba e filtro da lista; ficam na InboxView para os cartões do início levarem a lista a Ativos › Todos. */
export type ListView = { tab: Tab; sub: Sub };
const TABS: { value: Tab; label: string }[] = [
  { value: "ACTIVE", label: "Ativos" },
  { value: "AUTO", label: "Automáticos" },
  { value: "RESOLVED", label: "Resolvidos" },
];
const SUBS: { value: Sub; label: string }[] = [
  { value: "ALL", label: "Todos" },
  { value: "OPEN", label: "Abertos" },
  { value: "PENDING", label: "Pendentes" },
];
/** Cliente que já foi lido e espera resposta há este tempo: o tempo da linha fica em âmbar. */
const WAITING_MS = 10 * 60_000;

/** Lista de conversas (coluna de 320px do board Inbox). */
export function ConversationList({
  selectedId,
  onSelect,
  listedRef,
  view,
  onView,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Recebe as conversas na ordem mostrada (para "Resolver" abrir a seguinte). */
  listedRef: { current: string[] };
  view: ListView;
  onView: (view: ListView) => void;
}) {
  const { request, session } = useAuth();
  const master = session?.context?.mode === "master";
  const { tab, sub } = view;
  const setTab = (next: Tab) => onView({ tab: next, sub });
  const setSub = (next: Sub) => onView({ tab, sub: next });
  const status = tab === "ACTIVE" ? (sub === "ALL" ? "ACTIVE" : sub) : tab;
  const [search, setSearch] = useState("");
  const [tenantId, setTenantId] = useState<string | null>(null);
  const openCalling = useOpenCalling(onSelect);
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
  // Chamado sem urgência (entregador com outro assunto) tem o próprio som, discreto, sem o alarme.
  const quiet = allCounts.data?.awaitingQuiet ?? 0;
  const calling = (allCounts.data?.awaitingAgent ?? 0) - quiet;
  const alarm = useAgentAlarm(calling > 0, "urgent", allCounts.data?.urgentSince ?? null);
  const quietAlarm = useAgentAlarm(quiet > 0, "quiet");

  const items = conversations.data?.pages.flatMap((page) => page.items) ?? [];
  useUnreadSignals(items, calling + quiet);
  useEffect(() => {
    listedRef.current = items.map((conversation) => conversation.id);
  });
  const tenantName = (session?.context?.tenants ?? []).find((tenant) => tenant.id === tenantId)?.name;

  return (
    <section className="flex w-[clamp(248px,24vw,320px)] shrink-0 flex-col border-r border-rule bg-surface">
      <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-rule px-4">
        <h2 className="font-heading text-[16px] font-bold tracking-[-0.3px]">Inbox</h2>
        {master && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Filtrar por restaurante"
              className={cn(
                "flex h-7 max-w-[196px] items-center gap-1.5 rounded-md border bg-paper pr-1.5 pl-2 text-[11.5px]",
                tenantId ? "border-ink font-medium text-ink" : "border-rule text-ink-2",
              )}
            >
              <StoreIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{tenantName ?? "Todos os restaurantes"}</span>
              <ChevronDownIcon className="size-3 shrink-0" aria-hidden />
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
        <button
          type="button"
          role="alert"
          onClick={() => openCalling()}
          title="Abrir a conversa que espera há mais tempo"
          className="flex w-full shrink-0 items-center gap-2 bg-tomate px-4 py-2 text-left text-[12px] font-semibold text-white hover:bg-tomate/90"
        >
          <BellRingIcon className="size-4 shrink-0 animate-bounce" aria-hidden />
          <span className="flex-1">
            {calling === 1 ? "1 conversa chamando um atendente" : `${calling} conversas chamando um atendente`}
            {alarm.blocked && <span className="block text-[10.5px] font-normal opacity-90">Clique na página para ativar o som.</span>}
          </span>
          <span className="font-medium underline underline-offset-2">Abrir</span>
        </button>
      )}
      {quiet > 0 && (
        <div role="status" className="flex shrink-0 items-center gap-2 bg-ink px-4 py-2 text-[12px] font-semibold text-paper">
          <BellIcon className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">
            {quiet === 1 ? "1 conversa aguardando um atendente" : `${quiet} conversas aguardando um atendente`}
            {quietAlarm.blocked && <span className="block text-[10.5px] font-normal opacity-90">Clique na página para ativar o som.</span>}
          </span>
        </div>
      )}

      <div className="shrink-0 px-3 pt-2.5 pb-1.5">
        <label className="flex h-8 items-center gap-2 rounded-md border border-rule bg-paper px-2.5 focus-within:border-ink">
          <SearchIcon className="size-3.5 shrink-0 text-ink-3" aria-hidden />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por nome, telefone ou CPF"
            aria-label="Buscar conversa por nome, telefone ou CPF"
            className="w-full bg-transparent text-[12px] outline-none placeholder:text-ink-3"
          />
        </label>
      </div>

      <div role="tablist" aria-label="Conversas" className="flex shrink-0 gap-5 border-b border-rule px-3.5">
        {TABS.map((item) => {
          const total = item.value === "ACTIVE" ? (counts.data?.OPEN ?? 0) + (counts.data?.PENDING ?? 0) : 0;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              onClick={() => setTab(item.value)}
              className={cn(
                "relative -mb-px flex items-center gap-1.5 border-b-2 pt-2 pb-[9px] text-[12.5px]",
                tab === item.value ? "border-ink font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink-2",
              )}
            >
              {item.label}
              {total > 0 && (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-tomate px-1 text-[10px] font-bold text-white tabular-nums">
                  {total}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {tab === "ACTIVE" && (
        <div className="flex shrink-0 gap-1 border-b border-rule-soft px-3 py-2">
          {SUBS.map((item) => {
            const total = item.value === "OPEN" ? counts.data?.OPEN : item.value === "PENDING" ? counts.data?.PENDING : undefined;
            return (
              <button
                key={item.value}
                type="button"
                aria-pressed={sub === item.value}
                onClick={() => setSub(item.value)}
                className={cn(
                  "flex items-center gap-[5px] rounded-sm border px-[9px] py-[3px] text-[11px] whitespace-nowrap",
                  sub === item.value ? "border-ink bg-ink font-medium text-paper" : "border-rule text-ink-2 hover:bg-surface-2",
                )}
              >
                {item.label}
                {total !== undefined && <span className="opacity-70 tabular-nums">{total}</span>}
              </button>
            );
          })}
        </div>
      )}

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
                inResolvedTab={tab === "RESOLVED"}
                watchWaiting={tab === "ACTIVE"}
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
  inResolvedTab,
  watchWaiting,
  now,
  onSelect,
}: {
  conversation: ConversationListItem;
  active: boolean;
  showTenant: boolean;
  /** Na aba Resolvidos a linha não fica apagada nem repete o selo "Resolvida". */
  inResolvedTab: boolean;
  /** Aba Ativos: cliente já lido e sem resposta há 10 min ou mais tem o tempo em âmbar. */
  watchWaiting: boolean;
  now: number;
  onSelect: () => void;
}) {
  const unread = conversation.unreadCount > 0;
  const resolved = conversation.status === "RESOLVED";
  const calling = conversation.awaitingAgentSince !== null;
  const quiet = calling && conversation.awaitingAgentQuiet;
  const courier = conversation.contact.tags.includes(COURIER_TAG);
  const time = conversation.lastMessageAt ?? conversation.createdAt;
  const waiting =
    watchWaiting &&
    !calling &&
    !unread &&
    conversation.lastMessage?.direction === "INBOUND" &&
    now - new Date(time).getTime() >= WAITING_MS;
  const meta = [showTenant && conversation.tenant.name, conversation.orderCode && `#${conversation.orderCode}`].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full shrink-0 gap-2.5 border-b border-l-2 px-3.5 py-3 text-left",
        active
          ? "border-b-[#F5C4BC] border-l-tomate bg-tomate-lt dark:border-b-tomate-line"
          : "border-b-rule-soft border-l-transparent bg-surface hover:bg-paper",
        // Chamando o atendente: borda grossa e fundo tomate, para saltar aos olhos; sem urgência, só a borda, em ink.
        calling && (quiet ? "border-l-4 border-l-ink" : "border-l-4 border-l-tomate bg-tomate-lt hover:bg-tomate-lt"),
        resolved && !active && !inResolvedTab && "opacity-60",
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
          <div
            className={cn(
              "mb-1 inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] font-semibold",
              quiet ? "bg-ink text-paper" : "animate-pulse bg-tomate text-white",
            )}
          >
            {courier ? <BikeIcon className="size-3" aria-hidden /> : <BellRingIcon className="size-3" aria-hidden />}
            {courier ? "Entregador chamando" : "Chamando atendente"} · {ago(conversation.awaitingAgentSince!, now)}
          </div>
        )}
        <div className="mb-0.5 flex items-baseline justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className={cn("truncate text-[13px]", unread || active ? "font-semibold" : resolved ? "text-ink-2" : "")}>
              {conversation.contact.name ?? "Cliente sem nome"}
            </span>
            {conversation.status === "PENDING" && <StatusBadge tone="pending">Pendente</StatusBadge>}
            {resolved && !inResolvedTab && <StatusBadge tone="resolved">Resolvida</StatusBadge>}
            {conversation.contact.phoneStatus === "pending" && (
              <StatusBadge tone="pending" title="Telefone pendente">
                ⚠
              </StatusBadge>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-[5px]">
            <span
              title={waiting ? `Cliente sem resposta há ${ago(time, now)}` : undefined}
              className={cn(
                "flex items-center gap-1 text-[10.5px] tabular-nums",
                unread ? "font-semibold text-tomate" : waiting ? "font-semibold text-warning" : "text-ink-3",
              )}
            >
              {waiting && <ClockIcon className="size-[11px]" aria-hidden />}
              {ago(time, now)}
            </span>
            {unread && (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-tomate px-[3px] text-[9px] font-bold text-white tabular-nums">
                {conversation.unreadCount}
              </span>
            )}
          </div>
        </div>
        {meta && <div className="truncate text-[10.5px] text-ink-3 tabular-nums">{meta}</div>}
        <div className={cn("flex items-center gap-1 text-[11.5px]", unread ? "font-medium text-ink" : active ? "text-ink-2" : "text-ink-3")}>
          {conversation.lastMessage?.direction === "OUTBOUND" && (
            <CornerUpLeftIcon className="size-3 shrink-0" aria-label="Última mensagem da equipe" />
          )}
          <span className="truncate">{conversation.lastMessage?.preview ?? ""}</span>
        </div>
        {(conversation.fraudAlert || conversation.teamOnly) && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {conversation.fraudAlert && <FraudBadge />}
            {conversation.teamOnly && <TeamOnlyBadge />}
          </div>
        )}
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

/**
 * Abre a conversa que chama um atendente há mais tempo (a API põe quem está chamando no topo dos Ativos), em qualquer
 * restaurante e com qualquer filtro na lista. Alarme da lista e cartão "Chamando atendente" do início.
 */
export function useOpenCalling(onSelect: (id: string) => void) {
  const { request } = useAuth();
  const [open] = usePendingAction(async () => {
    const page = await request<ConversationPage>("/conversations?status=ACTIVE");
    const longest = page.items.find((conversation) => conversation.awaitingAgentSince && !conversation.awaitingAgentQuiet);
    if (longest) onSelect(longest.id);
  });
  return open;
}

export function useDebounced<T>(value: T, delayMs: number): T {
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

let lastBeep = 0;

/** A mesma mensagem pode ser vista pela lista e pela conversa aberta: um bipe só. */
export function beep() {
  if (Date.now() - lastBeep < 1_500) return;
  lastBeep = Date.now();
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
