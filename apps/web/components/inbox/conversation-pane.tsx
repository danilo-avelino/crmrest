"use client";

import {
  CHANNEL_LABEL,
  type ConversationCounts,
  type ConversationListItem,
  type ConversationMessages,
  type MemberDto,
  type UpdateConversationRequest,
} from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, EllipsisIcon, LoaderCircleIcon, SearchIcon, UserRoundIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { ClientDetail } from "@/components/clients/client-detail";
import { Avatar, ChannelDot, StatusBadge, TeamOnlyBadge } from "@/components/inbox/bits";
import { ClientPanel } from "@/components/inbox/client-panel";
import { beep } from "@/components/inbox/conversation-list";
import { Composer } from "@/components/inbox/composer";
import { TodayOrders, useProductionOrders } from "@/components/inbox/inbox-home";
import { MessageTimeline } from "@/components/inbox/message-timeline";
import { ConversationFraudAlert } from "@/components/orders/fraud-alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePendingAction } from "@/hooks/use-pending-action";
import { useNow } from "@/hooks/use-now";
import { ago, count } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Mensagem nova do cliente na conversa aberta: ela já conta como lida, então a lista não vê a não lida subir e não bipa.
 * O bipe sai daqui, com a mesma regra da lista: com o alarme de chamado tocando, ele já avisa.
 */
function useInboundBeep(conversationId: string, data: ConversationMessages | undefined) {
  const { request } = useAuth();
  const counts = useQuery({
    queryKey: ["counts", null],
    queryFn: () => request<ConversationCounts>("/conversations/counts"),
  });
  const calling = counts.data?.awaitingAgent ?? 0;
  const lastInbound = data?.messages.findLast((message) => message.direction === "INBOUND")?.id;
  const seen = useRef<{ conversationId: string; id: string | undefined } | null>(null);
  useEffect(() => {
    if (!data) return;
    const before = seen.current;
    seen.current = { conversationId, id: lastInbound };
    if (before?.conversationId === conversationId && lastInbound && lastInbound !== before.id && calling === 0) beep();
  }, [data, conversationId, lastInbound, calling]);
}

/** Conversa aberta + painel do cliente (colunas centrais e direita do board Inbox). */
export type SideTab = "client" | "orders";

export function ConversationPane({
  conversationId,
  onOpenConversation,
  nextConversationId,
  sideTab,
  onSideTab,
}: {
  conversationId: string;
  /** Troca a conversa aberta na Inbox; null volta para a Inbox sem conversa aberta. */
  onOpenConversation: (id: string | null) => void;
  /** A conversa que abre depois de esta ser resolvida (a seguinte na lista). */
  nextConversationId: () => string | null;
  /** Aba do painel da direita; fica a mesma ao trocar de conversa. */
  sideTab: SideTab;
  onSideTab: (tab: SideTab) => void;
}) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const [profileOpen, setProfileOpen] = useState(false);
  // Busca de pedido na barra de abas: null = fechada.
  const [orderSearch, setOrderSearch] = useState<string | null>(null);
  const conversation = useQuery({
    queryKey: ["conversation", conversationId],
    queryFn: () => request<ConversationListItem>(`/conversations/${conversationId}`),
  });
  const messages = useQuery({
    queryKey: ["messages", conversationId],
    queryFn: () => request<ConversationMessages>(`/conversations/${conversationId}/messages`),
  });

  // Abrir a conversa (ou receber mensagem com ela aberta) conta como leitura.
  const unread = conversation.data?.unreadCount ?? 0;
  useEffect(() => {
    if (unread === 0) return;
    void request(`/conversations/${conversationId}/read`, { method: "POST" }).then(() => {
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] });
    });
  }, [unread, conversationId, request, queryClient]);
  // Resolvida com ela aberta por outro caminho (uma automação, como a de inatividade, ou outra pessoa): sai dela como no
  // "Resolver", para a seguinte da lista ou, sem nenhuma, para o início. Aberta já resolvida (aba Resolvidos), fica.
  const status = conversation.data?.status;
  const seenStatus = useRef(status);
  useEffect(() => {
    const before = seenStatus.current;
    seenStatus.current = status;
    if (status === "RESOLVED" && before !== undefined && before !== "RESOLVED") onOpenConversation(nextConversationId());
  }, [status, onOpenConversation, nextConversationId]);
  useInboundBeep(conversationId, messages.data);

  if (conversation.isPending || messages.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-ink-3" aria-busy>
        <LoaderCircleIcon className="size-4 animate-spin" aria-hidden /> Carregando…
      </div>
    );
  }
  if (!conversation.data || !messages.data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[12px] text-ink-3">
        Não foi possível abrir a conversa.
        <Button variant="outline" size="sm" onClick={() => Promise.all([conversation.refetch(), messages.refetch()])}>
          Tentar de novo
        </Button>
      </div>
    );
  }

  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col border-r border-rule bg-paper">
        <ConversationHeader
          conversation={conversation.data}
          onResolved={onOpenConversation}
          nextConversationId={nextConversationId}
        />
        <ConversationFraudAlert conversationId={conversationId} teamOnly={conversation.data.teamOnly} />
        <MessageTimeline
          data={messages.data}
          contact={conversation.data.contact}
          tenantId={conversation.data.tenant.id}
          onOpenConversation={onOpenConversation}
        />
        <Composer conversation={conversation.data} />
      </section>
      <aside className="flex min-h-0 w-[clamp(288px,26vw,344px)] shrink-0 flex-col bg-surface">
        <SideTabs tab={sideTab} onTab={onSideTab} search={orderSearch} onSearch={setOrderSearch} />
        {sideTab === "client" ? (
          <ClientPanel
            contactId={conversation.data.contact.id}
            conversationId={conversationId}
            channelType={conversation.data.channel.type}
            onOpenProfile={() => setProfileOpen(true)}
            onOpenConversation={onOpenConversation}
          />
        ) : (
          <TodayOrders embedded search={orderSearch ?? ""} onOpenConversation={onOpenConversation} />
        )}
      </aside>
      {/* Cadastro completo do cliente, como na aba Clientes. */}
      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent aria-label="Cadastro do cliente" className="flex h-[min(820px,calc(100vh-4rem))] w-[1080px]">
          {profileOpen && <ClientDetail id={conversation.data.contact.id} onClose={() => setProfileOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Abas do painel da direita: o cliente da conversa e os pedidos em produção (com os atrasados à vista). A lupa abre, no
 * lugar das abas, a busca de pedido pelo número ou pelo nome do cliente (`search`, null = fechada).
 */
function SideTabs({
  tab,
  onTab,
  search,
  onSearch,
}: {
  tab: SideTab;
  onTab: (tab: SideTab) => void;
  search: string | null;
  onSearch: (search: string | null) => void;
}) {
  const orders = useProductionOrders();
  const late = orders.data?.items.filter((order) => order.late).length ?? 0;
  if (search !== null) {
    return (
      <div className="flex h-[52px] shrink-0 items-center border-b border-rule px-3">
        <label className="flex h-8 flex-1 items-center gap-2 rounded-md border border-rule bg-paper px-2.5 focus-within:border-ink">
          <SearchIcon className="size-3.5 shrink-0 text-ink-3" aria-hidden />
          <input
            autoFocus
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && onSearch(null)}
            placeholder="Buscar pedido por número ou nome"
            aria-label="Buscar pedido de hoje por número ou nome do cliente"
            className="w-full bg-transparent text-[12px] outline-none placeholder:text-ink-3"
          />
          <button type="button" aria-label="Fechar a busca" onClick={() => onSearch(null)} className="shrink-0 text-ink-3 hover:text-ink">
            <XIcon className="size-3.5" aria-hidden />
          </button>
        </label>
      </div>
    );
  }
  const item = (value: SideTab, label: string, extra?: React.ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === value}
      onClick={() => onTab(value)}
      className={cn(
        "relative -mb-px flex items-center gap-1.5 border-b-2 text-[13px]",
        tab === value ? "border-ink font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink-2",
      )}
    >
      {label}
      {extra}
    </button>
  );
  return (
    <div role="tablist" aria-label="Painel da conversa" className="flex h-[52px] shrink-0 gap-[22px] border-b border-rule px-4">
      {item("client", "Cliente")}
      {item(
        "orders",
        "Pedidos",
        orders.data && (
          <>
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-surface-2 px-1 text-[10px] font-semibold text-ink-2 tabular-nums">
              {count(orders.data.total)}
            </span>
            {late > 0 && <span className="text-[11px] font-semibold text-tomate tabular-nums">{late === 1 ? "1 atrasado" : `${count(late)} atrasados`}</span>}
          </>
        ),
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Buscar pedido"
        title="Buscar pedido por número ou nome"
        className="ml-auto self-center text-ink-3"
        onClick={() => {
          onTab("orders");
          onSearch("");
        }}
      >
        <SearchIcon aria-hidden />
      </Button>
    </div>
  );
}

const STATUS_BADGE = {
  OPEN: { tone: "open", label: "Aberta" },
  PENDING: { tone: "pending", label: "Pendente" },
  RESOLVED: { tone: "resolved", label: "Resolvida" },
} as const;

function ConversationHeader({
  conversation,
  onResolved,
  nextConversationId,
}: {
  conversation: ConversationListItem;
  onResolved: (next: string | null) => void;
  nextConversationId: () => string | null;
}) {
  const { request, session } = useAuth();
  const queryClient = useQueryClient();
  const now = useNow();
  const members = useQuery({
    queryKey: ["members", conversation.tenant.id],
    queryFn: () => request<MemberDto[]>(`/members?tenantId=${conversation.tenant.id}`),
  });

  const update = async (body: UpdateConversationRequest) => {
    await request(`/conversations/${conversation.id}`, { method: "PATCH", body });
    for (const queryKey of [["conversation", conversation.id], ["conversations"], ["counts"]]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
  const [assign] = usePendingAction((assignedUserId: string | null) => update({ assignedUserId }));
  const [setStatus] = usePendingAction((status: ConversationListItem["status"]) => update({ status }));
  // A seguinte é escolhida antes de a lista recarregar sem a conversa resolvida.
  const resolve = async () => {
    const next = nextConversationId();
    await update({ status: "RESOLVED" });
    onResolved(next);
  };

  const assigned = conversation.assignedUser;
  const subtitle = [
    session?.context?.mode === "master" && conversation.tenant.name,
    conversation.teamOnly ? "aberta pelo Dish Desk para o alerta" : null,
    `aberta há ${ago(conversation.createdAt, now)}`,
  ].filter(Boolean);
  const status = STATUS_BADGE[conversation.status];

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-rule bg-surface px-4">
      <Avatar seed={conversation.contact.id} name={conversation.contact.name} className="size-8 text-[11px]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-heading text-[15px] font-bold tracking-[-0.2px]">
            {conversation.contact.name ?? "Cliente sem nome"}
          </span>
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          {conversation.teamOnly && <TeamOnlyBadge />}
        </div>
        <div className="flex items-center gap-[5px] truncate text-[11px] text-ink-3 tabular-nums">
          <ChannelDot type={conversation.channel.type} />
          <span className="font-medium text-ink-2">
            {CHANNEL_LABEL[conversation.channel.type]}
            {conversation.orderCode && ` · #${conversation.orderCode}`}
          </span>
          <span className="truncate">· {subtitle.join(" · ")}</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="sm" className={cn("max-w-[170px]", assigned ? "text-ink" : "text-ink-2")} />}
            title="Responsável pela conversa"
          >
            <UserRoundIcon aria-hidden />
            <span className="truncate">{assigned ? shortName(assigned.name) : "Sem responsável"}</span>
            <ChevronDownIcon className="size-3" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {(members.data ?? []).map((member) => (
              <DropdownMenuItem key={member.id} onClick={() => assign(member.id)}>
                <span className="flex-1">
                  {member.name}
                  {member.id === session?.user.id && " (você)"}
                </span>
                {assigned?.id === member.id && <CheckIcon className="size-3.5" aria-hidden />}
              </DropdownMenuItem>
            ))}
            {assigned && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => assign(null)}>Remover atribuição</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {conversation.status === "RESOLVED" ? (
          <Button variant="outline" size="sm" onClick={() => update({ status: "OPEN" })}>
            Reabrir
          </Button>
        ) : (
          <Button size="sm" onClick={resolve}>
            Resolver
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label="Mais opções" />}>
            <EllipsisIcon aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {conversation.status !== "PENDING" && (
              <DropdownMenuItem onClick={() => setStatus("PENDING")}>Marcar como pendente</DropdownMenuItem>
            )}
            {conversation.status !== "OPEN" && (
              <DropdownMenuItem onClick={() => setStatus("OPEN")}>Marcar como aberta</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

/** "Ana Silva" → "Ana S." (como no cabeçalho do design). */
function shortName(name: string): string {
  const [first, ...rest] = name.split(" ");
  return rest.length ? `${first} ${rest.at(-1)!.charAt(0)}.` : name;
}
