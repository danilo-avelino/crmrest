"use client";

import { fillMessage, PERSONALITIES, PERSONALITY_INFO, PERSONALITY_MESSAGES, type Personality, type TenantSettingsDto } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { AutomationBubble, Card, CardBody, CardFooter, CardPreview, ToggleRow } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

function useCurrentSettings() {
  const { request } = useAuth();
  const tenant = useSettingsTenant();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => request<TenantSettingsDto[]>("/settings") });
  return { current: settings.data?.find((item) => item.tenantId === tenant.id), failed: settings.isError };
}

/** Grava uma configuração do restaurante e atualiza a lista em cache. */
function useSettingsUpdate(tenantId: string) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  return async (path: string, body: object) => {
    const updated = await request<TenantSettingsDto>(`/settings/${tenantId}/${path}`, { method: "PUT", body });
    queryClient.setQueryData<TenantSettingsDto[]>(["settings"], (list) => list?.map((item) => (item.tenantId === updated.tenantId ? updated : item)));
  };
}

/** Página "Personalidade": o tom da IA e dos avisos, e o que os avisos sobre o pedido dizem. */
export function PersonalityPage() {
  const { current, failed } = useCurrentSettings();
  if (!current) return <TabLoading failed={failed} />;
  return (
    <div className="flex flex-col gap-5">
      {/* A chave remonta o formulário ao trocar de restaurante no painel master. */}
      <PersonalityForm key={current.tenantId} settings={current} />
      <OrderMessagesCard settings={current} />
    </div>
  );
}

/** Só a personalidade (o passo do assistente de configuração). */
export function PersonalityTab() {
  const { current, failed } = useCurrentSettings();
  return current ? <PersonalityForm key={current.tenantId} settings={current} /> : <TabLoading failed={failed} />;
}

/** Personalidade: o tom da IA e de todos os avisos automáticos, com uma prévia antes de salvar. */
function PersonalityForm({ settings }: { settings: TenantSettingsDto }) {
  const update = useSettingsUpdate(settings.tenantId);
  const toast = useToast();
  const id = useId();
  const [personality, setPersonality] = useState<Personality>(settings.personality);
  const [failure, setFailure] = useState<string | null>(null);
  const preview = PERSONALITY_MESSAGES[personality];

  const save = async () => {
    setFailure(null);
    try {
      await update("personality", { personality });
      toast("Personalidade salva");
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível salvar.");
    }
  };

  return (
    <Card
      title="Personalidade do atendimento"
      description="O jeito de falar da IA com o cliente e o tom dos avisos automáticos: andamento do pedido, entrega, pesquisa de satisfação e encerramento."
    >
      <CardBody>
        <div role="radiogroup" aria-label="Personalidade do atendimento" className="grid grid-cols-3 gap-2.5">
          {PERSONALITIES.map((value) => (
            <label
              key={value}
              className={cn(
                "flex flex-col gap-0.5 rounded-xl border px-3.5 py-3 has-focus-visible:ring-3 has-focus-visible:ring-ring/8",
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
      </CardBody>
      <CardPreview label={`Prévia · ${PERSONALITY_INFO[personality].label}`}>
        <AutomationBubble label="pedido saiu para entrega" text={fillMessage(preview.dispatchNotice, { pedido: "95", hora: "19:45" })} />
        <AutomationBubble label="passagem para a equipe" text={preview.handoff} />
        <AutomationBubble label="pesquisa de satisfação" text={preview.surveyQuestion} />
      </CardPreview>
      <CardFooter error={failure} note={settings.canEdit ? undefined : "Só o administrador do restaurante altera a personalidade."}>
        {settings.canEdit && (
          <Button size="sm" disabled={personality === settings.personality} onClick={save}>
            Salvar
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

/**
 * O que as mensagens sobre o pedido dizem: a fila na previsão de saída (E26) e o convite de avaliação no chat do iFood
 * (E32, desligado por padrão, porque escreve a todo cliente com pedido entregue). Cada opção grava ao ser marcada.
 */
function OrderMessagesCard({ settings }: { settings: TenantSettingsDto }) {
  const update = useSettingsUpdate(settings.tenantId);
  const toast = useToast();
  const [failure, setFailure] = useState<string | null>(null);

  const change = async (path: string, body: object, saved: string) => {
    setFailure(null);
    try {
      await update(path, body);
      toast(saved);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível salvar.");
    }
  };

  return (
    <Card title="Mensagens sobre o pedido" description="O que o cliente recebe sobre o andamento e depois da entrega, no tom da personalidade escolhida.">
      <div className="divide-y divide-rule-soft border-t border-rule-soft">
        <ToggleRow
          label="Mostrar quantos pedidos estão na frente"
          hint="Na previsão de saída do pedido. Ex.: “Há 3 pedidos na sua frente na cozinha.” Conta os pedidos de hoje que ainda não saíram."
          checked={settings.orderForecast.showQueue}
          disabled={!settings.canEdit}
          onChange={(showQueue) => change("order-forecast", { showQueue }, "Previsão de saída salva")}
        />
        <ToggleRow
          label="Convidar o cliente a avaliar a loja no iFood"
          hint="No chat do pedido, 10 minutos depois da entrega. Pedidos cancelados ou entregues depois do horário prometido pelo iFood ficam de fora. Só sai com o Dish Desk aberto em um computador com a extensão do iFood."
          checked={settings.reviewInvite.enabled}
          disabled={!settings.canEdit}
          onChange={(enabled) => change("review-invite", { enabled }, "Convite de avaliação salvo")}
        />
      </div>
      {settings.reviewInvite.enabled && (
        <CardPreview label="Prévia do convite">
          <AutomationBubble label="convite de avaliação" text={fillMessage(PERSONALITY_MESSAGES[settings.personality].reviewInvite, { pedido: "95" })} />
        </CardPreview>
      )}
      {(failure || !settings.canEdit) && (
        <CardFooter error={failure} note="Só o administrador do restaurante altera estas mensagens." />
      )}
    </Card>
  );
}
