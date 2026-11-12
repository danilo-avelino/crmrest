"use client";

import type { IntegrationDto, IntegrationsDto } from "@dishdesk/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { clock, count, fullDate, monthYear } from "@/lib/format";

const BOX = "mt-3 flex flex-col gap-2 rounded-[10px] bg-paper px-[15px] py-[13px]";
const TITLE = "text-[10px] font-bold tracking-[0.07em] text-ink-3 uppercase";

/** O iFood só entrega pedidos novos: o alerta usa o que chegou desde a conexão. */
export function IfoodHistoryNote() {
  return (
    <div className={BOX}>
      <div className={TITLE}>Histórico de pedidos</div>
      <p className="m-0 text-[12px] leading-normal text-ink-2">O iFood não oferece os pedidos antigos da loja. O alerta de fraude usa os pedidos recebidos desde a conexão.</p>
    </div>
  );
}

/**
 * Importação do histórico da loja. Cardápio Web: só os cancelamentos, que é o que o alerta de fraude precisa. Neemo: todos
 * os pedidos, que classificam os clientes (pedidos, total gasto, VIP, Recorrente...) e ficam fora da aba Pedidos. Roda em segundo plano, então a tela só acompanha.
 */
export function OrderHistorySection({ tenantId, item, canEdit, queryKey }: { tenantId: string; item: IntegrationDto; canEdit: boolean; queryKey: readonly unknown[] }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const state = item.orderHistory;
  const running = state?.status === "running";
  const toast = useToast();
  const wasRunning = useRef(false);
  const neemo = item.type === "NEEMO";
  const system = neemo ? "a Neemo" : "o Cardápio Web";

  // Avisa quando a importação termina com a tela aberta (a consulta abaixo traz o novo estado, sem recarregar).
  useEffect(() => {
    if (wasRunning.current && state?.status === "done") toast("Histórico de pedidos importado");
    wasRunning.current = running;
  }, [running, state?.status, toast]);

  useEffect(() => {
    if (!running) return;
    const refresh = setInterval(() => void queryClient.invalidateQueries({ queryKey }), 5_000);
    return () => clearInterval(refresh);
  }, [running, queryClient, queryKey]);

  const start = async () => {
    setError(null);
    try {
      const saved = await request<IntegrationDto>(`/integrations/${tenantId}/${item.id}/order-history`, { method: "POST" });
      queryClient.setQueryData<IntegrationsDto>(queryKey, (current) =>
        current && { ...current, integrations: current.integrations.map((other) => (other.id === saved.id ? saved : other)) },
      );
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível começar a importação. Tente de novo.");
    }
  };

  const cancellations = (value: number) =>
    `${count(value)} ${neemo ? (value === 1 ? "pedido" : "pedidos") : value === 1 ? "cancelamento" : "cancelamentos"}`;
  const period = state?.from ? `, de ${monthYear(state.from)} a ${monthYear(state.to)}` : "";

  return (
    <div className={BOX}>
      <div className={TITLE}>Histórico de pedidos</div>
      {!state && (
        <p className="m-0 text-[12px] leading-normal text-ink-2">
          {neemo
            ? "Traga os pedidos antigos desta loja para o cadastro de cada cliente: quantos pedidos fez, quanto gastou e as tags VIP, Recorrente e Sumido. Eles também entram no alerta de fraude e não aparecem na aba Pedidos."
            : "Traga os cancelamentos antigos desta loja para o alerta de fraude considerar o histórico dos clientes."}{" "}
          Importamos até onde {system} guardar.
        </p>
      )}
      {running && (
        <>
          <div className="text-[12px] text-ink-2 tabular-nums">
            {cancellations(state.imported)} até agora{period}
          </div>
          <div className="h-1.5 overflow-hidden rounded-[3px] bg-surface-2" role="progressbar" aria-valuenow={state.progress} aria-valuemin={0} aria-valuemax={100} aria-label="Andamento da importação">
            <span className="block h-full bg-ink" style={{ width: `${state.progress}%` }} />
          </div>
          <p className="m-0 text-[12px] leading-normal text-ink-3">Pode levar alguns minutos. Você pode sair desta tela: a importação continua.</p>
        </>
      )}
      {state?.status === "done" && (
        <p className="m-0 flex-1 rounded-md border border-success-line bg-success-lt px-3 py-2 text-[12px] leading-normal text-success-ink">
          Importado em {fullDate(state.updatedAt)} às {clock(state.updatedAt)}: <strong className="font-semibold">{cancellations(state.imported)}</strong>
          {period}.
        </p>
      )}
      {state?.status === "partial" && (
        <p className="m-0 rounded-md border border-dashed border-tag-line bg-warning-lt px-3 py-2 text-[12px] leading-normal text-warning-ink">
          Importamos <strong className="font-semibold">{cancellations(state.imported)}</strong>
          {period}, mas {system} parou de responder antes do fim.
        </p>
      )}
      {state?.status === "error" && (
        <p role="alert" className="m-0 rounded-md border border-tomate-line bg-tomate-lt px-3 py-2 text-[12px] leading-normal text-tomate-ink">
          Não conseguimos importar o histórico: {system} não respondeu. Nada foi importado.
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 text-[12px] text-tomate">
          {error}
        </p>
      )}
      {canEdit && !running && state?.status !== "done" && (
        <div>
          <Button variant="outline" size="sm" onClick={start}>
            {!state ? "Importar histórico" : state.status === "partial" ? "Importar o que falta" : "Tentar de novo"}
          </Button>
        </div>
      )}
    </div>
  );
}
