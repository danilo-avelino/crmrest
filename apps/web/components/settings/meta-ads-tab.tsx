"use client";

import type { MenuStoreSettings } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";
import type { StoreResponse } from "@/lib/menu-store";
import { cn } from "@/lib/utils";

/** Pixel ID: só números (8 a 20), como o Gerenciador de Eventos mostra. Vazio tira o Pixel. */
export function metaAdsPayload(store: MenuStoreSettings, pixelId: string, testCode: string): { ok: true; body: MenuStoreSettings } | { ok: false; error: string } {
  const pixel = pixelId.replace(/\s/g, "");
  if (pixel && !/^\d{8,20}$/.test(pixel)) return { ok: false, error: "O Pixel ID tem só números (8 a 20)." };
  const { metaPixelId: _pixel, metaTestEventCode: _code, ...rest } = store;
  void _pixel;
  void _code;
  const test = testCode.trim().slice(0, 40);
  return { ok: true, body: { ...rest, ...(pixel ? { metaPixelId: pixel } : {}), ...(test ? { metaTestEventCode: test } : {}) } };
}

type CapiStage = { stage: string; browser: number | null; server: number; failed: number; lastSentAt: string | null };
type CapiStatus = {
  configured: boolean;
  last4: string | null;
  pixelConfigured: boolean;
  health: { hours: number; pairedPercent: number | null; stages: CapiStage[]; pending: number; lastError: { message: string; at: string | null } | null };
};

const STAGE_LABEL: Record<string, [string, string]> = {
  PAGE_VIEW: ["PageView", "visitou"],
  VIEW_CONTENT: ["ViewContent", "viu item"],
  ADD_TO_CART: ["AddToCart", "adicionou à sacola"],
  INITIATE_CHECKOUT: ["InitiateCheckout", "iniciou checkout"],
  ADD_PAYMENT_INFO: ["AddPaymentInfo", "gerou Pix"],
  PURCHASE: ["Purchase", "pagou"],
};

const hhmm = (iso: string) => new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Sao_Paulo" }).format(new Date(iso));
const count = (n: number) => n.toLocaleString("pt-BR");

/**
 * Configurações → Meta Ads (C3): Pixel ID, token da Conversions API (F7-04, guardado criptografado; só os 4 últimos
 * caracteres voltam) e código de teste num cartão; a saúde dos eventos (F7-08) no outro, com o período dentro do bloco.
 */
export function MetaAdsTab() {
  const { request } = useAuth();
  const tenant = useSettingsTenant();
  const query = useQuery({ queryKey: ["menu-store", tenant.id], queryFn: () => request<StoreResponse>(`/menu/${tenant.id}/store`), retry: false });
  if (query.error instanceof ApiError && query.error.status === 403) {
    return <p className="text-ink-3">O módulo Cardápio não está ativo neste restaurante.</p>;
  }
  return query.data ? <MetaAdsForm key={tenant.id} tenantId={tenant.id} data={query.data} /> : <TabLoading failed={query.isError} />;
}

function MetaAdsForm({ tenantId, data }: { tenantId: string; data: StoreResponse }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = useId();
  const tokenRef = useRef<HTMLInputElement>(null);
  const [hours, setHours] = useState<24 | 168>(24);
  const capi = useQuery({
    queryKey: ["meta-capi", tenantId, hours],
    queryFn: () => request<CapiStatus>(`/menu/${tenantId}/meta-capi?horas=${hours}`),
    refetchInterval: 60_000,
  });
  const [pixelId, setPixelId] = useState(data.store.metaPixelId ?? "");
  const [testCode, setTestCode] = useState(data.store.metaTestEventCode ?? "");
  const [token, setToken] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const storeChanged = pixelId !== (data.store.metaPixelId ?? "") || testCode !== (data.store.metaTestEventCode ?? "");
  const changed = storeChanged || token.trim() !== "";

  const putToken = async (value: string | null) => {
    await request<CapiStatus>(`/menu/${tenantId}/meta-capi`, { method: "PUT", body: { token: value } });
    await queryClient.invalidateQueries({ queryKey: ["meta-capi", tenantId] });
  };

  const [save, saving] = usePendingAction(async () => {
    setFailure(null);
    const result = metaAdsPayload(data.store, pixelId, testCode);
    if (!result.ok) return setFailure(result.error);
    try {
      if (storeChanged) {
        const updated = await request<StoreResponse>(`/menu/${tenantId}/store`, { method: "PUT", body: result.body });
        queryClient.setQueryData(["menu-store", tenantId], updated);
      }
      if (token.trim()) {
        await putToken(token.trim());
        setToken("");
      }
      toast("Meta Ads salvo");
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível salvar.");
    }
  });

  const turnOff = async () => {
    setFailure(null);
    try {
      await putToken(null);
      toast("Conversions API desligada");
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível desligar.");
    }
  };

  const status = capi.data;
  const health = status?.health;
  const receiving = Boolean(status?.configured && health?.stages.some((s) => s.server > 0));
  const failing = Boolean(health?.lastError && health.stages.some((s) => s.failed > 0));
  const pill = !status
    ? null
    : !status.pixelConfigured || !status.configured
      ? { text: "Não configurado", tone: "off" as const }
      : failing
        ? { text: "Meta recusando", tone: "bad" as const }
        : receiving
          ? { text: "Recebendo eventos", tone: "on" as const }
          : { text: "Aguardando eventos", tone: "off" as const };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button type="button" onClick={save} loading={saving} disabled={!changed}>
          Salvar
        </Button>
      </div>

      <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3 rounded-xl border border-rule bg-surface px-5 py-[18px]">
        <div className="flex items-center gap-2.5">
          <h3 id={`${id}-title`} className="m-0 flex-1 font-heading text-title font-semibold">
            Pixel e Conversions API
          </h3>
          {pill && (
            <span
              className={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-sm px-2 text-xs font-semibold",
                pill.tone === "on" ? "bg-success-lt text-success-ink" : pill.tone === "bad" ? "bg-tomate-lt text-tomate" : "bg-surface-2 text-ink-2",
              )}
            >
              <span className={cn("size-1.5 rounded-full", pill.tone === "on" ? "bg-success" : pill.tone === "bad" ? "bg-tomate" : "bg-ink-3")} aria-hidden />
              {pill.text}
            </span>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-[5px]">
            <Label htmlFor={`${id}-pixel`}>Pixel ID</Label>
            <Input id={`${id}-pixel`} inputMode="numeric" placeholder="Ex.: 123456789012345" value={pixelId} onChange={(e) => setPixelId(e.target.value)} />
          </div>
          <div className="flex flex-col gap-[5px]">
            <Label htmlFor={`${id}-token`}>Token da Conversions API</Label>
            <Input
              ref={tokenRef}
              id={`${id}-token`}
              type="password"
              autoComplete="off"
              placeholder={status?.configured ? `••••••••••••${status.last4 ?? ""}` : "Cole o token"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-[5px]">
            <Label htmlFor={`${id}-test`}>
              Código de teste de eventos <span className="font-normal text-ink-3">(opcional)</span>
            </Label>
            <Input id={`${id}-test`} placeholder="Ex.: TEST12345" value={testCode} onChange={(e) => setTestCode(e.target.value)} />
          </div>
        </div>
        <p className="m-0 text-[12px] text-ink-3">
          O token fica escondido depois de salvo. Com o código de teste preenchido, os eventos aparecem em “Testar eventos” no Gerenciador de Eventos. O Pixel só carrega depois que o
          visitante aceita os cookies (LGPD).
        </p>
        {status?.configured && (
          <div>
            <Button variant="outline" size="sm" onClick={turnOff}>
              Desligar a Conversions API
            </Button>
          </div>
        )}
        {failure && (
          <p role="alert" className="m-0 text-[12.5px] text-tomate">
            {failure}
          </p>
        )}
      </section>

      <section aria-labelledby={`${id}-health`} className="flex flex-col gap-3 rounded-xl border border-rule bg-surface px-5 py-[18px]">
        <h3 id={`${id}-health`} className="m-0 font-heading text-title font-semibold">
          Saúde dos eventos
        </h3>
        {!health ? (
          <p className="m-0 text-ink-3">{capi.isError ? "Não foi possível carregar." : "Carregando…"}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-heading text-display font-bold tabular-nums">{health.pairedPercent == null ? "—" : `${health.pairedPercent}%`}</span>
              <span className="flex-1 text-ink-2">dos eventos com par navegador e servidor</span>
              <select
                aria-label="Período"
                value={hours}
                onChange={(e) => setHours(Number(e.target.value) === 168 ? 168 : 24)}
                className="h-9 rounded-lg border border-rule bg-surface px-2.5 outline-none focus:border-ink"
              >
                <option value={24}>Últimas 24 h</option>
                <option value={168}>Últimos 7 dias</option>
              </select>
            </div>
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="text-[12px] text-ink-3">
                  <th className="border-b border-rule py-2 font-medium">Evento</th>
                  <th className="border-b border-rule py-2 text-right font-medium">Navegador</th>
                  <th className="border-b border-rule py-2 text-right font-medium">Servidor</th>
                  <th className="border-b border-rule py-2 pl-4 font-medium">Último</th>
                  <th className="border-b border-rule py-2 font-medium">Situação</th>
                </tr>
              </thead>
              <tbody>
                {health.stages.map((row) => {
                  const [name, hint] = STAGE_LABEL[row.stage] ?? [row.stage, ""];
                  const bad = row.failed > 0;
                  const none = row.server === 0 && !bad;
                  return (
                    <tr key={row.stage} className="border-b border-rule-soft last:border-b-0">
                      <td className="py-2.5">
                        <span className="font-medium">{name}</span> <span className="text-[12px] text-ink-3">{hint}</span>
                      </td>
                      <td className="py-2.5 text-right tabular-nums">{row.browser == null ? "—" : count(row.browser)}</td>
                      <td className="py-2.5 text-right tabular-nums">{count(row.server)}</td>
                      <td className="py-2.5 pl-4 tabular-nums">{row.lastSentAt ? hhmm(row.lastSentAt) : "—"}</td>
                      <td className="py-2.5">
                        <span className={cn("inline-flex items-center gap-1.5", bad ? "text-tomate" : none ? "text-ink-3" : "text-success-ink")}>
                          <span className={cn("size-1.5 rounded-full", bad ? "bg-tomate" : none ? "bg-ink-3" : "bg-success")} aria-hidden />
                          {bad ? `${count(row.failed)} recusados` : none ? "Sem eventos" : "OK"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {failing && health.lastError && (
              <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-tomate-lt px-3 py-2 text-[12.5px] text-tomate">
                <span className="flex-1">
                  A Meta recusou eventos{health.lastError.at ? ` (último às ${hhmm(health.lastError.at)})` : ""}: {health.lastError.message}
                </span>
                <Button variant="outline" size="sm" onClick={() => tokenRef.current?.focus()}>
                  Trocar o token
                </Button>
              </div>
            )}
            {!failing && health.pending > 0 && <p className="m-0 text-[12px] text-ink-3 tabular-nums">{count(health.pending)} na fila de envio (sai a cada minuto).</p>}
          </>
        )}
      </section>
    </div>
  );
}
