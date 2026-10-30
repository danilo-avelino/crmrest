"use client";

import type { PlatformAiStatusDto } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import { useAuth } from "@/components/auth/auth-provider";
import { PlatformLoading } from "@/components/platform/platform-header";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const PROVIDER_LABEL = { openai: "Servidor próprio", anthropic: "Claude" } as const;

/** Qual LLM do Atendimento com IA está atendendo agora: a local ou a reserva (ex.: o Claude). Confere ao abrir. */
export function PlatformAiStatus() {
  const { request } = useAuth();
  const status = useQuery({
    queryKey: ["platform-ai-status"],
    queryFn: () => request<PlatformAiStatusDto>("/platform/ai-status"),
    staleTime: Infinity,
  });
  const data = status.data;
  const serving = !data?.main ? null : data.main.online ? "main" : data.fallback?.online ? "fallback" : null;
  const servingLabel = !data?.main
    ? "IA desligada"
    : serving === "main"
      ? "Local"
      : serving === "fallback"
        ? `${PROVIDER_LABEL[data.fallback!.provider]} (reserva)`
        : "Nenhuma: a IA está fora do ar";

  return (
    <section className="overflow-hidden rounded-xl border border-rule">
      <div className="flex items-start justify-between gap-4 border-b border-rule px-5 pt-4 pb-3.5">
        <div>
          <h2 className="font-heading text-title font-semibold">Atendimento com IA</h2>
          <p className="mt-1 text-ink-2">
            A LLM local atende quando está no ar; fora do ar, a reserva assume.
            {data && <> Atendendo agora: <strong className="font-medium text-ink">{servingLabel}</strong>.</>}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => status.refetch()}>
          <RefreshCwIcon aria-hidden />
          Conferir de novo
        </Button>
      </div>
      <div className="bg-paper px-5 py-4">
        {data ? (
          <ul className="flex flex-col gap-2">
            <StatusRow label="Local" model={data.main?.model} online={data.main?.online} serving={serving === "main"} />
            <StatusRow
              label={data.fallback ? `Reserva · ${PROVIDER_LABEL[data.fallback.provider]}` : "Reserva"}
              model={data.fallback?.model}
              online={data.fallback?.online}
              serving={serving === "fallback"}
            />
          </ul>
        ) : (
          <PlatformLoading failed={status.isError} />
        )}
      </div>
    </section>
  );
}

function StatusRow({ label, model, online, serving }: { label: string; model?: string; online?: boolean; serving: boolean }) {
  return (
    <li className="flex items-center gap-3">
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", online === undefined ? "bg-ink-3" : online ? "bg-success" : "bg-tomate")}
      />
      <span className="w-44 shrink-0 font-medium">{label}</span>
      <span className="w-40 shrink-0 truncate text-ink-3">{model ?? "não configurada"}</span>
      {online !== undefined && <span className={online ? "text-success" : "text-tomate"}>{online ? "No ar" : "Fora do ar"}</span>}
      {serving && <span className="text-[12px] text-ink-3">· atendendo agora</span>}
    </li>
  );
}
