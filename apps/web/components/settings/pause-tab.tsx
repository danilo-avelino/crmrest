"use client";

import type { TenantSettingsDto } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
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
 * Aba "Pausa": desliga as automações e a IA em todos os canais do restaurante; as mensagens continuam chegando na
 * Inbox, não lidas, e a equipe responde normalmente. No painel master, pausa ou retoma também todos de uma vez.
 * Não existe no design: segue os cartões das outras abas. Desktop no MVP.
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
        "inline-flex h-[22px] items-center rounded-sm border px-2 text-[11px] font-medium",
        paused ? "border-warning-line bg-warning-lt text-warning-ink" : "border-success-line bg-success-lt text-success-ink",
      )}
    >
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
    <section className="overflow-hidden rounded-xl border border-rule">
      <div className="flex items-start justify-between gap-4 border-b border-rule px-5 pt-4 pb-3.5">
        <div>
          <h2 className="font-heading text-title font-semibold">Pausar o Dish Desk</h2>
          <p className="mt-1 text-ink-2">
            Nenhuma automação nem a IA age nos canais de <span className="font-medium">{settings.tenantName}</span>. As mensagens
            continuam chegando na Inbox, não lidas, e a equipe responde normalmente.
          </p>
        </div>
        <StatusBadge paused={paused} />
      </div>

      <div className="flex flex-col gap-4 px-5 py-4">
        {paused && (
          <p className="rounded-lg border border-warning-line bg-warning-lt px-3 py-2 text-[12px] text-warning-ink">
            O Dish Desk está pausado: ninguém recebe resposta automática até você retomar.
          </p>
        )}
        <div>
          <p className="mb-1.5 font-medium">{paused ? "Parado agora" : "O que para"}</p>
          <ul className="list-disc space-y-0.5 pl-5 text-ink-2">
            {STOPPED.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        {failure && (
          <p role="alert" className="text-[12px] text-tomate">
            {failure}
          </p>
        )}
        {settings.canEdit ? (
          <Button variant={paused ? "default" : "accent"} className="self-start" onClick={toggle}>
            {paused ? "Retomar o Dish Desk" : "Pausar o Dish Desk"}
          </Button>
        ) : (
          <p className="text-ink-3">Só o administrador do restaurante pausa ou retoma.</p>
        )}
      </div>
    </section>
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
    <section className="overflow-hidden rounded-xl border border-rule">
      <div className="border-b border-rule px-5 pt-4 pb-3.5">
        <h2 className="font-heading text-title font-semibold">Todos os restaurantes</h2>
        <p className="mt-1 text-ink-2">
          <span className="tabular-nums">{pausedCount}</span> de <span className="tabular-nums">{tenants.length}</span>{" "}
          {pausedCount === 1 ? "pausado" : "pausados"}.
        </p>
      </div>
      <div className="flex flex-col gap-3 px-5 py-4">
        <ul className="flex flex-col gap-1.5">
          {tenants.map((item) => (
            <li key={item.tenantId} className="flex items-center justify-between gap-3">
              <span>{item.tenantName}</span>
              <StatusBadge paused={item.paused} />
            </li>
          ))}
        </ul>
        {failure && (
          <p role="alert" className="text-[12px] text-tomate">
            {failure}
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="accent" disabled={pausedCount === tenants.length} onClick={() => setAll(true)}>
            Pausar todos
          </Button>
          <Button variant="outline" disabled={pausedCount === 0} onClick={() => setAll(false)}>
            Retomar todos
          </Button>
        </div>
      </div>
    </section>
  );
}
