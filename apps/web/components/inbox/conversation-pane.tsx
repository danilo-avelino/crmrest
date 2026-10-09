"use client";

import {
  CHANNEL_LABEL,
  type ConversationListItem,
  type ConversationMessages,
  type MemberDto,
  type UpdateConversationRequest,
} from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, EllipsisIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Avatar, ChannelDot } from "@/components/inbox/bits";
import { ClientPanel } from "@/components/inbox/client-panel";
import { Composer } from "@/components/inbox/composer";
import { MessageTimeline } from "@/components/inbox/message-timeline";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePendingAction } from "@/hooks/use-pending-action";
import { useNow } from "@/hooks/use-now";
import { ago } from "@/lib/format";

/** Conversa aberta + painel do cliente (colunas centrais e direita do board Inbox). */
export function ConversationPane({ conversationId }: { conversationId: string }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
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
        <ConversationHeader conversation={conversation.data} />
        <MessageTimeline data={messages.data} contact={conversation.data.contact} />
        <Composer conversation={conversation.data} />
      </section>
      <ClientPanel contactId={conversation.data.contact.id} conversationId={conversationId} />
    </>
  );
}

function ConversationHeader({ conversation }: { conversation: ConversationListItem }) {
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

  const assigned = conversation.assignedUser;
  const subtitle = [
    session?.context?.mode === "master" && conversation.tenant.name,
    assigned ? `Atribuído a: ${shortName(assigned.name)}` : "Sem responsável",
    `Aberto há ${ago(conversation.createdAt, now)}`,
  ].filter(Boolean);

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-rule bg-surface px-4">
      <Avatar seed={conversation.contact.id} name={conversation.contact.name} className="size-8 text-[11px]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-heading text-[15px] font-bold tracking-[-0.2px]">
            {conversation.contact.name ?? "Cliente sem nome"}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-2">
            <ChannelDot type={conversation.channel.type} />
            {CHANNEL_LABEL[conversation.channel.type]}
            {conversation.orderCode && ` · #${conversation.orderCode}`}
          </span>
        </div>
        <div className="truncate text-[10.5px] text-ink-3">{subtitle.join(" · ")}</div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>Atribuir</DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {(members.data ?? []).map((member) => (
              <DropdownMenuItem key={member.id} onClick={() => assign(member.id)}>
                <span className="flex-1">{member.name}</span>
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
          <Button size="sm" onClick={() => update({ status: "RESOLVED" })}>
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
