"use client";

import {
  type AutomationTexts,
  automationTextDefaults,
  fillMessage,
  menuMessage,
  PERSONALITIES,
  PERSONALITY_INFO,
  PERSONALITY_MESSAGES,
  type Personality,
  type TenantSettingsDto,
  UpdateAutomationTextsRequest,
} from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SparklesIcon } from "lucide-react";
import { useId, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

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
  if (!current) return <TabLoading failed={settings.isError} />;
  return (
    <div className="flex flex-col gap-5">
      <PersonalityForm key={`personality-${current.tenantId}`} settings={current} />
      {/* Remonta ao trocar a personalidade: os textos que seguiam o padrão mudam junto. */}
      <AutomationTextsForm key={`${current.tenantId}-${current.personality}`} settings={current} />
      <OrderForecastForm key={`forecast-${current.tenantId}`} settings={current} />
    </div>
  );
}

/** Personalidade: o tom de todas as mensagens automáticas, com uma prévia antes de salvar. */
function PersonalityForm({ settings }: { settings: TenantSettingsDto }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = useId();
  const [personality, setPersonality] = useState<Personality>(settings.personality);
  const [failure, setFailure] = useState<string | null>(null);
  const preview = PERSONALITY_MESSAGES[personality];

  const save = async () => {
    setFailure(null);
    try {
      const updated = await request<TenantSettingsDto>(`/settings/${settings.tenantId}/personality`, {
        method: "PUT",
        body: { personality },
      });
      queryClient.setQueryData<TenantSettingsDto[]>(["settings"], (list) =>
        list?.map((item) => (item.tenantId === updated.tenantId ? updated : item)),
      );
      toast("Personalidade salva");
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível salvar.");
    }
  };

  return (
    <section className="overflow-hidden rounded-xl border border-rule">
      <div className="border-b border-rule px-5 pt-4 pb-3.5">
        <h2 className="font-heading text-title font-semibold">Personalidade do atendimento</h2>
        <p className="mt-1 text-ink-2">
          O tom de todas as mensagens automáticas: menu, busca do pedido, previsão de saída, avisos de entrega, pesquisa de satisfação e
          encerramento. Os textos que você editou abaixo continuam valendo.
        </p>
      </div>

      <div className="flex flex-col gap-3 px-5 py-4">
        <div role="radiogroup" aria-label="Personalidade do atendimento" className="grid grid-cols-3 gap-2">
          {PERSONALITIES.map((value) => (
            <label
              key={value}
              className={cn(
                "flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 has-focus-visible:ring-3 has-focus-visible:ring-ring/8",
                personality === value ? "border-ink bg-paper" : "border-rule",
                settings.canEdit ? "cursor-pointer hover:bg-paper" : "opacity-55",
              )}
            >
              <input
                type="radio"
                name={`${id}-personality`}
                value={value}
                checked={personality === value}
                disabled={!settings.canEdit}
                onChange={() => setPersonality(value)}
                className="sr-only"
              />
              <span className="text-[13px] font-medium">{PERSONALITY_INFO[value].label}</span>
              <span className="text-[11px] leading-snug text-ink-3">{PERSONALITY_INFO[value].description}</span>
            </label>
          ))}
        </div>
        {settings.canEdit ? (
          <div className="flex justify-end">
            <Button size="sm" disabled={personality === settings.personality} onClick={save}>
              Salvar
            </Button>
          </div>
        ) : (
          <p className="text-[12px] text-ink-3">Só o administrador do restaurante altera a personalidade.</p>
        )}
        {failure && (
          <p role="alert" className="text-[11px] text-tomate">
            {failure}
          </p>
        )}
      </div>

      <div className="border-t border-rule bg-paper px-5 py-4">
        <div className="mb-2 text-[10px] font-semibold tracking-[0.08em] text-ink-3 uppercase">
          Prévia · {PERSONALITY_INFO[personality].label}
        </div>
        <div className="flex flex-col gap-2">
          <AutomationBubble label="menu de atendimento" text={menuMessage(preview.greeting, "Maria")} />
          <AutomationBubble label="pedido saiu para entrega" text={fillMessage(preview.dispatchNotice, { pedido: "95", hora: "19:45" })} />
          <AutomationBubble label="pesquisa de satisfação" text={preview.surveyQuestion} />
        </div>
      </div>
    </section>
  );
}

function AutomationBubble({ label, text }: { label: string; text: string }) {
  return (
    <div className="max-w-[440px] rounded-[10px] border border-warning-line bg-warning-lt px-3.5 py-2.5">
      <div className="mb-1 flex items-center gap-[5px] text-[10.5px] font-semibold text-warning-ink">
        <SparklesIcon className="size-3" aria-hidden />
        Automação · {label}
      </div>
      <div className="leading-[1.45] break-words whitespace-pre-wrap">{text}</div>
    </div>
  );
}

/** Previsão de saída do pedido (E26): o restaurante escolhe se o cliente vê quantos pedidos estão na frente. */
function OrderForecastForm({ settings }: { settings: TenantSettingsDto }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [showQueue, setShowQueue] = useState(settings.orderForecast.showQueue);
  const [failure, setFailure] = useState<string | null>(null);

  const save = async () => {
    setFailure(null);
    try {
      const updated = await request<TenantSettingsDto>(`/settings/${settings.tenantId}/order-forecast`, {
        method: "PUT",
        body: { showQueue },
      });
      queryClient.setQueryData<TenantSettingsDto[]>(["settings"], (list) =>
        list?.map((item) => (item.tenantId === updated.tenantId ? updated : item)),
      );
      toast("Previsão de saída salva");
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível salvar.");
    }
  };

  return (
    <section className="overflow-hidden rounded-xl border border-rule">
      <div className="border-b border-rule px-5 pt-4 pb-3.5">
        <h2 className="font-heading text-title font-semibold">Previsão de saída do pedido</h2>
        <p className="mt-1 text-ink-2">
          Enviada quando o cliente confirma o pedido pela automação (com um pedido de desculpas, se estiver atrasado) e pelo botão
          “Enviar previsão” do card do pedido.
        </p>
      </div>
      <div className="flex flex-col gap-3 px-5 py-4">
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-ink"
            checked={showQueue}
            disabled={!settings.canEdit}
            onChange={(event) => setShowQueue(event.target.checked)}
          />
          <span>
            <span className="block text-[13px] font-medium">Mostrar quantos pedidos estão na frente</span>
            <span className="text-[11px] text-ink-3">Ex.: “Há 3 pedidos na sua frente na cozinha.” Conta os pedidos de hoje que ainda não saíram.</span>
          </span>
        </label>
        {settings.canEdit && (
          <div className="flex justify-end">
            <Button size="sm" disabled={showQueue === settings.orderForecast.showQueue} onClick={save}>
              Salvar
            </Button>
          </div>
        )}
        {failure && (
          <p role="alert" className="text-[11px] text-tomate">
            {failure}
          </p>
        )}
      </div>
    </section>
  );
}

function AutomationTextsForm({ settings }: { settings: TenantSettingsDto }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [texts, setTexts] = useState<AutomationTexts>(settings.automationTexts);
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const dirty = JSON.stringify(texts) !== JSON.stringify(settings.automationTexts);
  const defaults = automationTextDefaults(settings.personality);

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
        <p className="mt-1 text-ink-2">
          O que as automações enviam em nome do restaurante, no WhatsApp e no Instagram. Os textos começam com os da personalidade
          escolhida; “Restaurar o padrão” volta para o dela.
        </p>
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
              {settings.canEdit && texts[key] !== defaults[key] && (
                <button
                  type="button"
                  className="text-[11px] text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline"
                  onClick={() => setTexts((current) => ({ ...current, [key]: defaults[key] }))}
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
          <div className="leading-[1.45] break-words whitespace-pre-wrap">{menuMessage(texts.greeting || defaults.greeting, "Maria")}</div>
        </div>
      </div>
    </section>
  );
}
