"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { type FormEvent, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { SalesRules } from "@/components/settings/sales-rules";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { SettingsHeader, TEXTAREA } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";
import type { MenuTree } from "@/lib/menu";
import {
  type AgentForm,
  type AgentSettingsResponse,
  formChanged,
  formToPayload,
  linesOfResponse,
  rulesCounter,
  type SimulationCart,
  type SimulationLine,
  type SimulationResponse,
  settingsToForm,
  simulationBody,
  simulationError,
} from "@/lib/menu-agent";
import { cn } from "@/lib/utils";

/** Página "Pedidos pela IA" (C4): liga e desliga, nome, regras da casa, Venda pela IA e a simulação de conversa. */
export function MenuAgentTab() {
  const { request } = useAuth();
  const tenant = useSettingsTenant();
  const query = useQuery({
    queryKey: ["menu-agent", tenant.id],
    queryFn: () => request<AgentSettingsResponse>(`/menu/${tenant.id}/agent-settings`),
    retry: false,
  });
  if (query.error instanceof ApiError && query.error.status === 403) {
    return <p className="text-ink-3">O módulo Cardápio não está ativo neste restaurante.</p>;
  }
  return query.data ? <MenuAgentPage key={tenant.id} tenantId={tenant.id} data={query.data} /> : <TabLoading failed={query.isError} />;
}

/** O interruptor do design: pílula com o estado escrito ("Ligada" / "Desligada"). */
function Toggle({ checked, onChange, on, off, label }: { checked: boolean; onChange: (value: boolean) => void; on: string; off: string; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border py-0 pr-2.5 pl-[5px] text-xs font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
        checked ? "border-success-line bg-success-lt text-success-ink" : "border-rule bg-surface-2 text-ink-3",
      )}
    >
      <span className={cn("size-[18px] rounded-full", checked ? "bg-success" : "bg-ink-3")} aria-hidden />
      {checked ? on : off}
    </button>
  );
}

function MenuAgentPage({ tenantId, data }: { tenantId: string; data: AgentSettingsResponse }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [saved, setSaved] = useState(data.settings);
  const [form, setForm] = useState<AgentForm>(() => settingsToForm(data.settings));
  const [failure, setFailure] = useState<string | null>(null);
  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const changed = formChanged(form, saved);
  const menu = useQuery({ queryKey: ["menu", tenantId], queryFn: () => request<MenuTree>(`/menu/${tenantId}`) });
  const selling = form.suggestAddons && form.maxSuggestions !== "0";

  const [save, saving] = usePendingAction(async () => {
    setFailure(null);
    const result = formToPayload(form, data.rulesMax);
    if (!result.ok) return setFailure(result.error);
    try {
      const updated = await request<AgentSettingsResponse>(`/menu/${tenantId}/agent-settings`, { method: "PUT", body: result.body });
      setSaved(updated.settings);
      setForm(settingsToForm(updated.settings));
      queryClient.setQueryData(["menu-agent", tenantId], updated);
      toast("Pedidos pela IA salvos");
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível salvar.");
    }
  });

  return (
    <>
      <SettingsHeader title="Pedidos pela IA" description="Como a IA atende os pedidos no WhatsApp com o seu cardápio. As mudanças valem para as próximas mensagens.">
        <Button type="button" onClick={save} loading={saving} disabled={!changed}>
          Salvar
        </Button>
      </SettingsHeader>
      {failure && (
        <p role="alert" className="mb-4 text-[12px] text-tomate">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap items-start gap-4">
        <section className="flex min-w-0 flex-[999_1_420px] flex-col gap-3.5 rounded-xl border border-rule bg-surface px-5 py-[18px]">
          <div className="flex items-center gap-2.5">
            <span className="flex-1">
              <span className="block font-semibold">A IA monta os pedidos no WhatsApp</span>
              <span className="text-xs text-ink-3">
                {form.enabled ? "O agente atende os pedidos com o cardápio ativo." : "Desligada: o atendente com IA responde como antes, sem montar pedido."}
              </span>
            </span>
            <Toggle checked={form.enabled} onChange={(value) => set("enabled", value)} on="Ligada" off="Desligada" label="A IA monta os pedidos no WhatsApp" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="agent-name" className="font-medium">
              Nome do atendente
            </label>
            <Input id="agent-name" value={form.attendantName} maxLength={30} placeholder="Ex.: Vila" onChange={(event) => set("attendantName", event.target.value)} />
            <span className="text-xs text-ink-3">A IA se apresenta com esse nome. Vazio: sem nome.</span>
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex justify-between">
              <label htmlFor="agent-rules" className="font-medium">
                Regras da casa
              </label>
              <span className="text-xs text-ink-3">{rulesCounter(form.houseRules, data.rulesMax)}</span>
            </div>
            <textarea
              id="agent-rules"
              rows={4}
              className={TEXTAREA}
              value={form.houseRules}
              aria-invalid={form.houseRules.length > data.rulesMax || undefined}
              placeholder="Ex.: Não aceitamos meio a meio em pizza broto. Pedidos acima de R$ 300 passam para a equipe confirmar."
              onChange={(event) => set("houseRules", event.target.value)}
            />
            <span className="text-xs text-ink-3">Instruções suas para o atendimento. Preço, taxa e status do pedido nunca mudam por aqui.</span>
          </div>
          <div className="flex flex-col gap-2.5 border-t border-rule-soft pt-2.5">
            <div className="flex items-center gap-2.5">
              <span className="flex-1">
                <span className="block font-medium">Venda pela IA</span>
                <span className="text-xs text-ink-3">
                  A IA oferece mais itens pelas regras abaixo: ao pedir algo de uma categoria ou no fim, se faltar uma categoria. O preço é sempre o do cardápio.
                </span>
              </span>
              <Toggle checked={form.suggestAddons} onChange={(value) => set("suggestAddons", value)} on="Ligada" off="Desligada" label="Venda pela IA" />
              <label htmlFor="agent-suggestions" className="font-medium">
                Até
              </label>
              <select
                id="agent-suggestions"
                className="h-9 rounded-lg border border-input bg-surface px-2 text-[13px] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/8 disabled:opacity-55"
                value={form.maxSuggestions}
                disabled={!form.suggestAddons}
                onChange={(event) => set("maxSuggestions", event.target.value)}
              >
                <option value="0">0 ofertas (não oferecer)</option>
                <option value="1">1 oferta por conversa</option>
                <option value="2">2 ofertas por conversa</option>
                <option value="3">3 ofertas por conversa</option>
              </select>
            </div>
            <SalesRules menu={menu.data} rules={form.salesRules} disabled={!selling} onChange={(rules) => set("salesRules", rules)} />
            <label className={cn("flex items-center gap-2 text-[13px]", !selling && "opacity-55")}>
              <input type="checkbox" checked={form.usePairings} disabled={!selling} onChange={(event) => set("usePairings", event.target.checked)} />
              {'Também oferecer o "Combina com" de cada item (nas categorias sem regra ao pedir)'}
            </label>
          </div>
          <div className="text-ink-2">
            Tom: usa a personalidade <span className="font-semibold">{data.personality.label}</span>.{" "}
            <Link href="/configuracoes" className="font-medium text-ink underline underline-offset-2">
              Mudar em Personalidade
            </Link>
          </div>
        </section>
        <Simulator tenantId={tenantId} data={data} />
      </div>
    </>
  );
}

/** "Simular conversa": o agente real com o cardápio real; nada é gravado nem enviado. */
function Simulator({ tenantId, data }: { tenantId: string; data: AgentSettingsResponse }) {
  const { request } = useAuth();
  const [lines, setLines] = useState<SimulationLine[]>([]);
  const [cart, setCart] = useState<SimulationCart | null>(null);
  const [salesOffers, setSalesOffers] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(!data.aiConfigured);
  const endRef = useRef<HTMLDivElement>(null);

  const [send, sending] = usePendingAction(async () => {
    const message = text.trim();
    if (!message) return;
    setError(null);
    const next: SimulationLine[] = [...lines, { kind: "user", text: message }];
    setLines(next);
    setText("");
    try {
      const response = await request<SimulationResponse>(`/menu/${tenantId}/agent-simulate`, { method: "POST", body: simulationBody(next, cart, salesOffers) });
      setCart(response.cart);
      setSalesOffers(response.salesOffers ?? []);
      setLines([...next, ...linesOfResponse(response)]);
    } catch (failure) {
      // A mensagem volta para o campo: nada foi respondido.
      setLines(lines);
      setText(message);
      setError(simulationError(failure));
      if (failure instanceof ApiError && failure.status === 503) setUnavailable(true);
    }
    queueMicrotask(() => endRef.current?.scrollIntoView?.({ block: "end" }));
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    send();
  }

  return (
    <section aria-label="Simular conversa" className="flex h-[620px] max-w-[400px] min-w-0 flex-[1_1_340px] flex-col rounded-xl border border-rule bg-surface">
      <div className="flex items-start justify-between gap-2 border-b border-rule-soft px-3.5 py-3">
        <div>
          <h2 className="font-heading text-title font-semibold">Simular conversa</h2>
          <p className="text-xs text-ink-3">Usa o cardápio real. Nenhum pedido é criado e nada é enviado. Até {data.simulationDailyLimit} por dia.</p>
        </div>
        {lines.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              setLines([]);
              setCart(null);
              setSalesOffers([]);
              setError(null);
            }}
          >
            Recomeçar
          </Button>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto bg-paper px-3.5 py-3" aria-live="polite">
        {lines.length === 0 && <p className="m-auto max-w-[240px] text-center text-ink-3">{'Escreva como um cliente, por exemplo: "tem pizza de calabresa?"'}</p>}
        {lines.map((line, index) =>
          line.kind === "note" ? (
            <div key={index} className="self-center rounded-lg bg-warning-lt px-2.5 py-1.5 text-center text-xs text-warning-ink">
              {line.text}
            </div>
          ) : (
            <div
              key={index}
              className={cn(
                "max-w-[80%] px-2.5 py-[7px] whitespace-pre-line",
                line.kind === "user" ? "self-start rounded-[12px_12px_12px_2px] border border-rule bg-surface" : "self-end rounded-[12px_12px_2px_12px] bg-ink text-paper",
              )}
            >
              {line.text}
            </div>
          ),
        )}
        {sending && <div className="self-center text-xs text-ink-3">Carregando…</div>}
        <div ref={endRef} />
      </div>
      {unavailable && (
        <p role="alert" className="border-t border-rule-soft bg-warning-lt px-3.5 py-2 text-xs text-warning-ink">
          A IA não está configurada neste ambiente (falta a chave da API do Claude). A simulação não está disponível.
        </p>
      )}
      {error && !unavailable && (
        <p role="alert" className="border-t border-rule-soft px-3.5 py-2 text-xs text-tomate">
          {error}
        </p>
      )}
      <form onSubmit={submit} className="flex gap-2 border-t border-rule-soft px-3.5 py-2.5">
        <Input aria-label="Mensagem de teste" placeholder="Escreva como um cliente" value={text} maxLength={1000} disabled={unavailable} onChange={(event) => setText(event.target.value)} />
        <Button type="submit" loading={sending} disabled={unavailable || !text.trim()}>
          Enviar
        </Button>
      </form>
    </section>
  );
}
