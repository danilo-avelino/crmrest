"use client";

import { CHANNEL_CAPABILITIES, CHANNEL_LABEL, type ConversationListItem, type QuickReplyDto } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClockIcon, ImageIcon, MicIcon, PaperclipIcon, SendIcon, StickyNoteIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TemplatePicker } from "@/components/inbox/template-picker";
import { Button } from "@/components/ui/button";
import { usePendingAction } from "@/hooks/use-pending-action";
import { useNow } from "@/hooks/use-now";
import { ApiError } from "@/lib/api";
import { remaining } from "@/lib/format";
import { cn } from "@/lib/utils";

type Mode = "reply" | "note";

/** Área de resposta (board Inbox → "Input área"). */
export function Composer({ conversation }: { conversation: ConversationListItem }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const now = useNow();
  const [mode, setMode] = useState<Mode>("reply");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);

  const capabilities = CHANNEL_CAPABILITIES[conversation.channel.type];
  const windowOpen =
    !capabilities.window24h || (conversation.windowExpiresAt !== null && new Date(conversation.windowExpiresAt).getTime() > now);
  const blocked =
    mode === "reply" &&
    (!capabilities.send
      ? // O nome do sistema, não o da integração (que pode ser "Loja Centro").
        `O ${CHANNEL_LABEL[conversation.channel.type]} não permite responder pelo Dish Desk. Use uma nota interna para registrar o atendimento.`
      : !windowOpen
        ? "A janela de 24h terminou. Para retomar a conversa, envie um template aprovado (botão Template)."
        : null);

  const quickReplies = useQuery({
    queryKey: ["quick-replies"],
    queryFn: () => request<QuickReplyDto[]>("/quick-replies"),
    enabled: mode === "reply",
  });
  const slash = mode === "reply" && /^\/\S*$/.test(text) ? text.slice(1).toLowerCase() : null;
  const suggestions =
    slash === null
      ? []
      : (quickReplies.data ?? []).filter(
          (reply) => reply.tenantId === conversation.tenant.id && reply.shortcut.toLowerCase().startsWith(slash),
        );

  const [submit, submitting] = usePendingAction(async () => {
    const body = text.trim();
    if (!body || blocked) return;
    setError(null);
    try {
      await request(`/conversations/${conversation.id}/${mode === "reply" ? "messages" : "notes"}`, {
        method: "POST",
        body: { text: body },
      });
      setText("");
      for (const queryKey of [["messages", conversation.id], ["conversation", conversation.id], ["conversations"]]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível enviar. Tente novamente.");
    }
  });

  const pick = (reply: QuickReplyDto) => {
    setText(reply.content);
    setHighlight(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight((current) => (current + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(suggestions[Math.min(highlight, suggestions.length - 1)]!);
        return;
      }
      if (event.key === "Escape") {
        setText("");
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="shrink-0 border-t border-rule bg-surface">
      <div className="flex border-b border-rule px-4" role="tablist">
        {(
          [
            ["reply", "Responder"],
            ["note", "Nota interna"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => {
              setMode(value);
              setError(null);
            }}
            className={cn(
              "-mb-px border-b-2 px-3.5 py-2 text-[12px]",
              mode === value ? "border-ink font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink-2",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="relative flex flex-col gap-2 px-3.5 pt-2.5 pb-2">
        {suggestions.length > 0 && (
          <ul
            role="listbox"
            aria-label="Respostas rápidas"
            className="absolute right-3.5 bottom-full left-3.5 mb-1 max-h-56 overflow-y-auto rounded-lg bg-popover p-1 shadow-md ring-1 ring-ink/10"
          >
            {suggestions.map((reply, index) => (
              <li key={reply.id} role="option" aria-selected={index === highlight}>
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(reply);
                  }}
                  className={cn("flex w-full flex-col rounded-md px-2 py-1.5 text-left", index === highlight && "bg-surface-2")}
                >
                  <span className="text-[12px] font-medium">/{reply.shortcut}</span>
                  <span className="truncate text-[11.5px] text-ink-3">{reply.content}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {blocked ? (
          <p className="min-h-16 rounded-lg border border-rule bg-surface-2 px-3 py-2.5 text-[12.5px] text-ink-3">{blocked}</p>
        ) : (
          <textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            rows={3}
            aria-label={mode === "reply" ? "Mensagem para o cliente" : "Nota interna para a equipe"}
            placeholder={
              mode === "reply"
                ? "Escreva uma mensagem... / para respostas rápidas"
                : "Escreva uma nota para a equipe (o cliente não vê)"
            }
            className={cn(
              "min-h-16 resize-none rounded-lg border px-3 py-2.5 text-[13px] outline-none placeholder:text-ink-3 focus:border-ink focus:ring-3 focus:ring-ink/8",
              mode === "note" ? "border-warning-line bg-warning-lt" : "border-rule bg-paper",
            )}
          />
        )}

        {error && (
          <p role="alert" className="text-[11px] text-tomate">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            {/* Envio de mídia ainda não existe no MVP. */}
            {[
              { label: "Anexar arquivo", icon: PaperclipIcon },
              { label: "Imagem", icon: ImageIcon },
              { label: "Áudio", icon: MicIcon },
            ].map(({ label, icon: Icon }) => (
              <Button key={label} variant="outline" size="icon-sm" disabled aria-label={label} title={`${label} (em breve)`}>
                <Icon aria-hidden />
              </Button>
            ))}
            <div className="mx-1 h-[18px] w-px bg-rule" />
            {conversation.channel.type === "WHATSAPP" ? (
              <TemplatePicker conversationId={conversation.id} emphasized={!windowOpen} />
            ) : (
              <Button variant="outline" size="sm" disabled title="Templates só existem no WhatsApp" className="text-[11.5px]">
                Template
              </Button>
            )}
            {capabilities.window24h && (
              <span
                className={cn("ml-2 flex items-center gap-1 text-[11px]", windowOpen ? "text-ink-3" : "text-tomate")}
                title="Resposta livre só até 24h depois da última mensagem do cliente"
              >
                <ClockIcon className="size-3" aria-hidden />
                {windowOpen && conversation.windowExpiresAt
                  ? `Janela de 24h: ${remaining(conversation.windowExpiresAt, now)} restantes`
                  : "Janela de 24h encerrada"}
              </span>
            )}
          </div>
          <Button
            variant={mode === "reply" ? "accent" : "default"}
            className="h-8 rounded-md px-3.5 text-[12.5px]"
            disabled={Boolean(blocked) || !text.trim()}
            loading={submitting}
            onClick={() => submit()}
          >
            {mode === "reply" ? (
              <>
                Enviar <SendIcon aria-hidden />
              </>
            ) : (
              <>
                Salvar nota <StickyNoteIcon aria-hidden />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
