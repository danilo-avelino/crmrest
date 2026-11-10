"use client";

import type { TenantSettingsDto } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { Card, CardBody, CardFooter, Eyebrow } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/** O que deixa de acontecer com o Dish Desk pausado (o que a API trava). */
const STOPPED = [
  "Menu de atendimento e atendimento com IA",
  "Avisos de pedido pronto, saiu para entrega, entregue e cancelado",
  "Pesquisa de satisfação, coleta de telefone e encerramento por inatividade",
  "Convite de avaliação no chat do iFood",
  "Revisão das respostas e avaliação dos atendimentos pela IA",
  "Relatório semanal pelo WhatsApp",
];

/**
 * Página "Pausa": desliga as automações e a IA em todos os canais do restaurante; as mensagens continuam chegando na
 * Inbox, não lidas, e a equipe responde normalmente. No painel master, pausa ou retoma também todos de uma vez.
 * Não existe no design: segue os cartões das outras páginas. Desktop no MVP.
 */
export function PauseTab() {
  const { request } = useAuth();
  const tenant = useSettingsTenant();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => request<TenantSettingsDto[]>("/settings") });
  const current = settings.data?.find((item) => item.tenantId === tenant.id);
  if (!settings.data || !current) return <TabLoading failed={settings.isError} />;
  const editable = settings.data.filter((item) => item.canEdit);
  return (
    <div className="flex flex-col gap-5">
      <PauseCard settings={current} />
      {editable.length > 1 && <PauseAllCard tenants={editable} />}
    </div>
  );
}

/** Grava a pausa de cada restaurante e atualiza a lista em cache. */
function usePauseUpdate() {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  return async (tenantId: string, paused: boolean) => {
    const updated = await request<TenantSettingsDto>(`/settings/${tenantId}/pause`, { method: "PUT", body: { paused } });
    queryClient.setQueryData<TenantSettingsDto[]>(["settings"], (list) =>
      list?.map((item) => (item.tenantId === updated.tenantId ? updated : item)),
    );
  };
}

function StatusBadge({ paused }: { paused: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-[5px] rounded-full px-2 py-0.5 text-[10px] font-bold tracking-[0.02em]",
        paused ? "bg-warning-lt text-warning-ink" : "bg-success-lt text-success-ink",
      )}
    >
      <span className={cn("size-[5px] rounded-full", paused ? "bg-warning" : "bg-success")} aria-hidden />
      {paused ? "Pausado" : "Ativo"}
    </span>
  );
}

function PauseCard({ settings }: { settings: TenantSettingsDto }) {
  const toast = useToast();
  const update = usePauseUpdate();
  const [failure, setFailure] = useState<string | null>(null);
  const { paused } = settings;

  const toggle = async () => {
    setFailure(null);
    try {
      await update(settings.tenantId, !paused);
      toast(paused ? "Dish Desk retomado" : "Dish Desk pausado");
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível salvar.");
    }
  };

  return (
    <Card
      title="Pausar o Dish Desk"
      description={
        <>
          Nenhuma automação nem a IA age nos canais de <span className="font-medium text-ink">{settings.tenantName}</span>. As mensagens
          continuam chegando na Inbox, não lidas, e a equipe responde normalmente.
        </>
      }
      aside={<StatusBadge paused={paused} />}
    >
      <CardBody className="flex flex-col gap-4">
        {paused && (
          <p className="rounded-xl border border-warning-line bg-warning-lt px-[13px] py-[11px] text-[12px] leading-normal text-warning-ink">
            O Dish Desk está pausado: ninguém recebe resposta automática até você retomar.
          </p>
        )}
        <div className="rounded-[10px] bg-paper px-[15px] py-[13px]">
          <Eyebrow className="mb-2">{paused ? "Parado agora" : "O que para"}</Eyebrow>
          <ul className="list-disc space-y-1 pl-4 leading-normal text-ink-2">
            {STOPPED.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </CardBody>
      <CardFooter error={failure} note={settings.canEdit ? undefined : "Só o administrador do restaurante pausa ou retoma."}>
        {settings.canEdit && (
          <Button variant={paused ? "default" : "accent"} size="sm" onClick={toggle}>
            {paused ? "Retomar o Dish Desk" : "Pausar o Dish Desk"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

/** Painel master: pausa ou retoma todos os restaurantes que o usuário administra. */
function PauseAllCard({ tenants }: { tenants: TenantSettingsDto[] }) {
  const toast = useToast();
  const update = usePauseUpdate();
  const [failure, setFailure] = useState<string | null>(null);
  const pausedCount = tenants.filter((item) => item.paused).length;

  const setAll = async (paused: boolean) => {
    setFailure(null);
    const results = await Promise.allSettled(
      tenants.filter((item) => item.paused !== paused).map((item) => update(item.tenantId, paused)),
    );
    const failed = results.filter((result) => result.status === "rejected").length;
    if (failed) return setFailure(`Não foi possível ${paused ? "pausar" : "retomar"} ${failed === 1 ? "1 restaurante" : `${failed} restaurantes`}. Tente de novo.`);
    toast(paused ? "Todos os restaurantes pausados" : "Todos os restaurantes retomados");
  };

  return (
    <Card
      title="Todos os restaurantes"
      description={
        <>
          <span className="tabular-nums">{pausedCount}</span> de <span className="tabular-nums">{tenants.length}</span>{" "}
          {pausedCount === 1 ? "pausado" : "pausados"}.
        </>
      }
    >
      <ul className="divide-y divide-rule-soft border-t border-rule-soft">
        {tenants.map((item) => (
          <li key={item.tenantId} className="flex items-center justify-between gap-3 px-6 py-3">
            <span className="truncate">{item.tenantName}</span>
            <StatusBadge paused={item.paused} />
          </li>
        ))}
      </ul>
      <CardFooter error={failure}>
        <Button variant="outline" size="sm" disabled={pausedCount === 0} onClick={() => setAll(false)}>
          Retomar todos
        </Button>
        <Button variant="accent" size="sm" disabled={pausedCount === tenants.length} onClick={() => setAll(true)}>
          Pausar todos
        </Button>
      </CardFooter>
    </Card>
  );
}
