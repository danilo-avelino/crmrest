"use client";

import {
  AUTOMATION_TEXT_DEFAULTS,
  type AutomationTexts,
  menuMessage,
  type TenantSettingsDto,
  UpdateAutomationTextsRequest,
} from "@comanda/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";

type Key = keyof AutomationTexts;

const FIELDS: { key: Key; label: string; help: string }[] = [
  {
    key: "greeting",
    label: "Saudação do menu",
    help: "Primeira resposta de um atendimento no WhatsApp e no Instagram. {nome} vira o primeiro nome do cliente; as opções 1, 2 e 3 entram no fim.",
  },
  { key: "phoneRequest", label: "Pedido de telefone", help: "Para quem chega sem telefone (Instagram), assim que o menu termina." },
  { key: "phoneReminder", label: "Lembrete do telefone", help: "Enviado uma vez, 10 minutos depois, se o cliente não responder." },
  { key: "phoneConfirmation", label: "Telefone recebido", help: "Quando o número informado é válido e vai para o cadastro." },
];

/** Aba "Mensagens automáticas": textos que as automações enviam em nome do restaurante. */
export function AutomationTextsTab() {
  const { request } = useAuth();
  const tenant = useSettingsTenant();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => request<TenantSettingsDto[]>("/settings") });
  const current = settings.data?.find((item) => item.tenantId === tenant.id);
  return current ? <AutomationTextsForm key={current.tenantId} settings={current} /> : <TabLoading failed={settings.isError} />;
}

function AutomationTextsForm({ settings }: { settings: TenantSettingsDto }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [texts, setTexts] = useState<AutomationTexts>(settings.automationTexts);
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const dirty = JSON.stringify(texts) !== JSON.stringify(settings.automationTexts);

  const [save, saving] = usePendingAction(async () => {
    setFailure(null);
    const parsed = UpdateAutomationTextsRequest.safeParse(texts);
    if (!parsed.success) {
      return setErrors(Object.fromEntries(parsed.error.issues.map((issue) => [issue.path[0], issue.message])));
    }
    setErrors({});
    try {
      const updated = await request<TenantSettingsDto>(`/settings/${settings.tenantId}/automation-texts`, {
        method: "PUT",
        body: parsed.data,
      });
      queryClient.setQueryData<TenantSettingsDto[]>(["settings"], (list) =>
        list?.map((item) => (item.tenantId === updated.tenantId ? updated : item)),
      );
      setTexts(updated.automationTexts);
      toast("Mensagens salvas");
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível salvar.");
    }
  });

  return (
    <section className="overflow-hidden rounded-xl border border-rule">
      <div className="border-b border-rule px-5 pt-4 pb-3.5">
        <h2 className="font-heading text-title font-semibold">Mensagens automáticas</h2>
        <p className="mt-1 text-ink-2">O que as automações enviam em nome do restaurante, no WhatsApp e no Instagram.</p>
      </div>

      <form
        noValidate
        className="flex flex-col gap-4 px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        {FIELDS.map(({ key, label, help }) => (
          <div key={key} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={`text-${key}`}>{label}</Label>
              {settings.canEdit && texts[key] !== AUTOMATION_TEXT_DEFAULTS[key] && (
                <button
                  type="button"
                  className="text-[11px] text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline"
                  onClick={() => setTexts((current) => ({ ...current, [key]: AUTOMATION_TEXT_DEFAULTS[key] }))}
                >
                  Restaurar o padrão
                </button>
              )}
            </div>
            <textarea
              id={`text-${key}`}
              rows={2}
              maxLength={1000}
              value={texts[key]}
              disabled={!settings.canEdit}
              aria-invalid={Boolean(errors[key]) || undefined}
              onChange={(event) => setTexts((current) => ({ ...current, [key]: event.target.value }))}
              className="w-full resize-y rounded-lg border border-input bg-surface px-3 py-2 text-[13px] leading-normal outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/8 disabled:opacity-55 aria-invalid:border-destructive"
            />
            {errors[key] ? (
              <p role="alert" className="text-[11px] text-tomate">
                {errors[key]}
              </p>
            ) : (
              <p className="text-[11px] text-ink-3">{help}</p>
            )}
          </div>
        ))}

        {settings.canEdit ? (
          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={saving} disabled={!dirty}>
              Salvar
            </Button>
          </div>
        ) : (
          <p className="text-[12px] text-ink-3">Só o administrador do restaurante altera as mensagens.</p>
        )}
        {failure && (
          <p role="alert" className="text-[11px] text-tomate">
            {failure}
          </p>
        )}
      </form>

      <div className="border-t border-rule bg-paper px-5 py-4">
        <div className="mb-2 text-[10px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Prévia do menu</div>
        <div className="max-w-[440px] rounded-[10px] border border-warning-line bg-warning-lt px-3.5 py-2.5">
          <div className="mb-1 flex items-center gap-[5px] text-[10.5px] font-semibold text-warning-ink">
            <SparklesIcon className="size-3" aria-hidden />
            Automação · menu de atendimento
          </div>
          <div className="leading-[1.45] break-words whitespace-pre-wrap">{menuMessage(texts.greeting || AUTOMATION_TEXT_DEFAULTS.greeting, "Maria")}</div>
        </div>
      </div>
    </section>
  );
}
