"use client";

import {
  type AiAttendanceDto,
  CHANNEL_CAPABILITIES,
  CHANNEL_LABEL,
  type ConversationListItem,
  type ConversationMessages,
  type QuickReplyDto,
  type ReplySuggestionDto,
} from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, ClockIcon, SendIcon, SparklesIcon, StickyNoteIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { useIfoodWidget } from "@/components/ifood-widget";
import { TemplatePicker } from "@/components/inbox/template-picker";
import { Button } from "@/components/ui/button";
import { usePendingAction } from "@/hooks/use-pending-action";
import { useNow } from "@/hooks/use-now";
import { ApiError } from "@/lib/api";
import { remaining } from "@/lib/format";
import { cn } from "@/lib/utils";

type Mode = "reply" | "note";

/** Intervalo entre as respostas do atendente na mesma conversa: 15 s, e 30 s depois da terceira, sem o cliente responder. */
const COOLDOWN_MS = 15_000;
const LONG_COOLDOWN_MS = 30_000;
const LONG_COOLDOWN_FROM = 3;
// Por conversa: quantas respostas o atendente mandou e quando mandou a última. Fica fora do componente para valer ao trocar de conversa e voltar.
const sentReplies = new Map<string, { count: number; at: number }>();
/** A sugestão da IA lê as mensagens das últimas 12 horas (como a API). */
const SUGGESTION_HISTORY_MS = 12 * 60 * 60 * 1000;

/** Área de resposta (board Inbox → "Input área"). */
export function Composer({ conversation }: { conversation: ConversationListItem }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const now = useNow(1_000);
  const [, setSentTick] = useState(0);
  const [mode, setMode] = useState<Mode>("reply");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  // O texto que veio da IA: enquanto o campo for igual a ele, a linha "Sugestão da IA" aparece.
  const [suggested, setSuggested] = useState<string | null>(null);

  const capabilities = CHANNEL_CAPABILITIES[conversation.channel.type];
  // O iFood só aceita resposta com a trava do chat ligada: o painel digita a mensagem no widget, pela extensão.
  const ifoodChat = useIfoodWidget().data?.chat === true;
  const canSend = capabilities.send || (conversation.channel.type === "IFOOD" && ifoodChat);
  const windowOpen =
    !capabilities.window24h || (conversation.windowExpiresAt !== null && new Date(conversation.windowExpiresAt).getTime() > now);
  const blocked =
    mode === "reply" &&
    (!canSend
      ? // O nome do sistema, não o da integração (que pode ser "Loja Centro").
        `O ${CHANNEL_LABEL[conversation.channel.type]} não permite responder pelo Dish Desk. Use uma nota interna para registrar o atendimento.`
      : !windowOpen
        ? "A janela de 24h terminou. Para retomar a conversa, envie um template aprovado (botão Template)."
        : null);

  // O cliente respondeu depois da última resposta: a contagem recomeça.
  const lastSent = sentReplies.get(conversation.id);
  if (lastSent && conversation.lastMessage?.direction === "INBOUND" && conversation.lastMessageAt && new Date(conversation.lastMessageAt).getTime() > lastSent.at) {
    sentReplies.delete(conversation.id);
  }
  const sent = sentReplies.get(conversation.id);
  const waitMs = sent ? (sent.count >= LONG_COOLDOWN_FROM ? LONG_COOLDOWN_MS : COOLDOWN_MS) - (now - sent.at) : 0;
  const cooling = mode === "reply" && waitMs > 0;
  const seconds = Math.ceil(waitMs / 1_000);

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

  // Sugerir com IA (board Inbox · Composer · Sugerir com IA): só no restaurante com o Atendimento com IA (a mesma
  // consulta do início da Inbox) e com mensagem do cliente para responder.
  const ai = useQuery({ queryKey: ["ai-attendance"], queryFn: () => request<AiAttendanceDto[]>("/ai/attendance") });
  const canSuggest = ai.data?.some((item) => item.tenantId === conversation.tenant.id) === true;
  const messages = useQuery({
    queryKey: ["messages", conversation.id],
    queryFn: () => request<ConversationMessages>(`/conversations/${conversation.id}/messages`),
    enabled: canSuggest,
  });
  const customerWrote = (messages.data?.messages ?? []).some(
    (message) => message.direction === "INBOUND" && now - new Date(message.createdAt).getTime() < SUGGESTION_HISTORY_MS,
  );
  const showSuggestion = suggested !== null && text === suggested;

  const [suggest, suggesting] = usePendingAction(async () => {
    if (text.trim()) return;
    setError(null);
    try {
      const suggestion = await request<ReplySuggestionDto>(`/conversations/${conversation.id}/suggestion`, { method: "POST" });
      setText(suggestion.text);
      setSuggested(suggestion.text);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "A IA não conseguiu sugerir uma resposta agora. Tente de novo.");
    }
  });

  const discard = () => {
    setText("");
    setSuggested(null);
  };

  const [submit, submitting] = usePendingAction(async () => {
    const body = text.trim();
    if (!body || blocked || cooling) return;
    setError(null);
    try {
      await request(`/conversations/${conversation.id}/${mode === "reply" ? "messages" : "notes"}`, {
        method: "POST",
        body: { text: body },
      });
      setText("");
      setSuggested(null);
      if (mode === "reply") {
        sentReplies.set(conversation.id, { count: (sentReplies.get(conversation.id)?.count ?? 0) + 1, at: Date.now() });
        setSentTick((tick) => tick + 1);
      }
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

        {mode === "reply" && showSuggestion && (
          <div className="flex items-center gap-[7px] text-[11px] text-ink-2">
            <SparklesIcon className="size-3 shrink-0 text-tomate" aria-hidden />
            <span>
              <b className="font-semibold text-tomate">Sugestão da IA</b> · revise antes de enviar
            </span>
            <Button variant="ghost" size="xs" className="ml-auto" onClick={discard}>
              <XIcon aria-hidden />
              Descartar
            </Button>
          </div>
        )}

        {blocked ? (
          <p className="min-h-16 rounded-lg border border-rule bg-surface-2 px-3 py-2.5 text-[12.5px] text-ink-3">{blocked}</p>
        ) : (
          <textarea
            value={suggesting ? "" : text}
            disabled={suggesting}
            onChange={(event) => {
              setText(event.target.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            rows={3}
            aria-label={mode === "reply" ? "Mensagem para o cliente" : "Nota interna para a equipe"}
            placeholder={
              suggesting
                ? "A IA está escrevendo uma sugestão…"
                : mode === "reply"
                  ? "Escreva uma mensagem... / para respostas rápidas"
                  : "Escreva uma nota para a equipe (o cliente não vê)"
            }
            className={cn(
              "min-h-16 resize-none rounded-lg border px-3 py-2.5 text-[13px] outline-none placeholder:text-ink-3 focus:border-ink focus:ring-3 focus:ring-ink/8 disabled:bg-surface-2",
              mode === "note" ? "border-warning-line bg-warning-lt" : "border-rule bg-paper",
              mode === "reply" && showSuggestion && "border-tomate-line ring-3 ring-tomate/8",
            )}
          />
        )}

        {cooling && (
          <p role="status" className="text-[11.5px] text-warning-ink">
            <span className="font-medium tabular-nums">Próxima mensagem em {seconds}s.</span> Para uma performance melhor, digite tudo o que tem a
            dizer em uma única mensagem.
          </p>
        )}

        {error && (
          <p role="alert" className="flex items-center gap-1.5 text-[11px] text-tomate">
            <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            {/* Templates são da API oficial do WhatsApp, a única com janela de 24h; pelo QR Code, a resposta é sempre livre. */}
            {conversation.channel.type === "WHATSAPP" && capabilities.window24h && (
              <TemplatePicker conversationId={conversation.id} emphasized={!windowOpen} disabled={suggesting} />
            )}
            {mode === "reply" && canSuggest && (
              // A dica explica o botão desabilitado sem mensagem do cliente (o hover vale no invólucro: o botão desabilitado não recebe o mouse).
              <span className="group/suggest relative">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-[11.5px]"
                  disabled={Boolean(blocked) || !customerWrote || text.trim() !== ""}
                  loading={suggesting}
                  onClick={() => suggest()}
                >
                  <SparklesIcon className="text-tomate group-data-disabled/button:text-ink-3" aria-hidden />
                  Sugerir com IA
                </Button>
                {!customerWrote && !blocked && (
                  <span
                    role="tooltip"
                    className="pointer-events-none invisible absolute bottom-10 left-1/2 z-10 w-[230px] -translate-x-1/2 rounded-lg bg-ink px-2.5 py-2 text-[11.5px] leading-[1.4] text-paper shadow-md group-hover/suggest:visible"
                  >
                    Sem mensagem do cliente para responder. A sugestão aparece quando ele escrever.
                    <span className="absolute -bottom-1 left-1/2 size-2 -translate-x-1/2 rotate-45 bg-ink" aria-hidden />
                  </span>
                )}
              </span>
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
            disabled={Boolean(blocked) || cooling || suggesting || !text.trim()}
            loading={submitting}
            onClick={() => submit()}
          >
            {cooling ? (
              <span className="tabular-nums">Aguarde {seconds}s</span>
            ) : mode === "reply" ? (
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
