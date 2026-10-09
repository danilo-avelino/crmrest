"use client";

import { type QuickReplyDto, QuickReplyRequest } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";

/** Aba "Respostas rápidas": o que o atendente escolhe digitando "/" no composer. Só o admin altera. */
export function QuickRepliesTab() {
  const { request } = useAuth();
  const tenant = useSettingsTenant();
  const canEdit = tenant.role === "ADMIN";
  const [editing, setEditing] = useState<string | null>(null);
  const replies = useQuery({ queryKey: ["quick-replies"], queryFn: () => request<QuickReplyDto[]>("/quick-replies") });
  if (!replies.data) return <TabLoading failed={replies.isError} />;
  const own = replies.data.filter((reply) => reply.tenantId === tenant.id);

  return (
    <section className="overflow-hidden rounded-xl border border-rule">
      <div className="border-b border-rule px-5 pt-4 pb-3.5">
        <h2 className="font-heading text-title font-semibold">Respostas rápidas</h2>
        <p className="mt-1 text-ink-2">
          No composer, o atendente digita <span className="font-medium text-ink">/</span> e o atalho para inserir a resposta.
        </p>
      </div>

      {own.length === 0 ? (
        <p className="px-5 py-4 text-ink-3 italic">Nenhuma resposta rápida cadastrada.</p>
      ) : (
        <ul>
          {own.map((reply) =>
            editing === reply.id ? (
              <li key={reply.id} className="border-b border-rule-soft">
                <ReplyForm tenantId={tenant.id} reply={reply} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li key={reply.id} className="flex items-start gap-3 border-b border-rule-soft px-5 py-3">
                <span className="w-32 shrink-0 truncate font-medium text-ink">/{reply.shortcut}</span>
                <p className="min-w-0 flex-1 whitespace-pre-wrap text-ink-2">{reply.content}</p>
                {canEdit && (
                  <div className="flex shrink-0 gap-1">
                    <Button variant="ghost" size="icon-sm" aria-label={`Editar /${reply.shortcut}`} onClick={() => setEditing(reply.id)}>
                      <PencilIcon aria-hidden />
                    </Button>
                    <DeleteButton tenantId={tenant.id} reply={reply} />
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      )}

      {canEdit ? (
        <div className="bg-paper">
          <div className="px-5 pt-4 text-[10px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Nova resposta</div>
          <ReplyForm tenantId={tenant.id} />
        </div>
      ) : (
        <p className="px-5 py-4 text-[12px] text-ink-3">Só o administrador do restaurante altera as respostas rápidas.</p>
      )}
    </section>
  );
}

/** Formulário de criar (sem `reply`) ou editar uma resposta. */
function ReplyForm({ tenantId, reply, onDone }: { tenantId: string; reply?: QuickReplyDto; onDone?: () => void }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = useId();
  const [shortcut, setShortcut] = useState(reply?.shortcut ?? "");
  const [content, setContent] = useState(reply?.content ?? "");
  const [errors, setErrors] = useState<{ shortcut?: string; content?: string; form?: string }>({});

  const [save, saving] = usePendingAction(async () => {
    const parsed = QuickReplyRequest.safeParse({ shortcut, content });
    if (!parsed.success) {
      const field = (name: string) => parsed.error.issues.find((issue) => issue.path[0] === name)?.message;
      return setErrors({ shortcut: field("shortcut"), content: field("content") });
    }
    setErrors({});
    try {
      await request(`/settings/${tenantId}/quick-replies${reply ? `/${reply.id}` : ""}`, {
        method: reply ? "PATCH" : "POST",
        body: parsed.data,
      });
      await queryClient.invalidateQueries({ queryKey: ["quick-replies"] });
      toast(reply ? "Resposta rápida atualizada" : "Resposta rápida criada");
      if (!reply) {
        setShortcut("");
        setContent("");
      }
      onDone?.();
    } catch (error) {
      setErrors({ form: error instanceof ApiError ? error.message : "Não foi possível salvar." });
    }
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-2.5 px-5 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="grid grid-cols-[160px_minmax(0,1fr)] gap-x-2 gap-y-1">
        <Label htmlFor={`${id}-shortcut`}>Atalho</Label>
        <Label htmlFor={`${id}-content`}>Resposta</Label>
        <Input
          id={`${id}-shortcut`}
          value={shortcut}
          maxLength={31}
          placeholder="/atraso"
          aria-invalid={Boolean(errors.shortcut) || undefined}
          onChange={(event) => setShortcut(event.target.value)}
        />
        <textarea
          id={`${id}-content`}
          rows={2}
          value={content}
          maxLength={1000}
          placeholder="Já estamos verificando seu pedido."
          aria-invalid={Boolean(errors.content) || undefined}
          onChange={(event) => setContent(event.target.value)}
          className="w-full resize-y rounded-lg border border-input bg-surface px-3 py-2 text-[13px] leading-normal outline-none placeholder:text-ink-3 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/8 aria-invalid:border-destructive"
        />
      </div>
      {[errors.shortcut, errors.content, errors.form].filter(Boolean).map((message) => (
        <p key={message} role="alert" className="text-[11px] text-tomate">
          {message}
        </p>
      ))}
      <div className="flex justify-end gap-2">
        {reply && (
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={onDone}>
            Cancelar
          </Button>
        )}
        <Button type="submit" size="sm" loading={saving}>
          {reply ? (
            "Salvar"
          ) : (
            <>
              <PlusIcon aria-hidden />
              Adicionar
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

function DeleteButton({ tenantId, reply }: { tenantId: string; reply: QuickReplyDto }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (error) return <span className="text-[11px] text-tomate">{error}</span>;
  if (!confirming) {
    return (
      <Button variant="ghost" size="icon-sm" aria-label={`Apagar /${reply.shortcut}`} onClick={() => setConfirming(true)}>
        <Trash2Icon aria-hidden />
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <Button
        variant="destructive"
        size="xs"
        onClick={async () => {
          try {
            await request(`/settings/${tenantId}/quick-replies/${reply.id}`, { method: "DELETE" });
            await queryClient.invalidateQueries({ queryKey: ["quick-replies"] });
            toast("Resposta rápida apagada");
          } catch (failure) {
            setError(failure instanceof ApiError ? failure.message : "Não foi possível apagar.");
          }
        }}
      >
        Apagar
      </Button>
      <Button variant="ghost" size="xs" onClick={() => setConfirming(false)}>
        Cancelar
      </Button>
    </span>
  );
}
