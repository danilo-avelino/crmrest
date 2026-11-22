"use client";

import {
  AUTO_TAG_INFO,
  BENEFIT_FREQUENCIES,
  BENEFIT_FREQUENCY_LABEL,
  BENEFIT_TAGS,
  BENEFIT_TITLE,
  type BenefitTag,
  type TagBenefitsSettings,
} from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { Card, CardBody } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { useNow } from "@/hooks/use-now";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";
import { centsText, parseCents } from "@/lib/menu";

type RecoveryContact = { contactId: string; name: string | null; phone: string | null; tags: string[]; conversationId: string | null; windowOpen: boolean; lastOfferAt: string | null };

/** Campos em texto (R$) para o corpo do PUT; devolve a mensagem do primeiro valor inválido. */
export function benefitsPayload(form: TagBenefitsSettings, money: Record<string, string>): { ok: true; body: TagBenefitsSettings } | { ok: false; error: string } {
  const cents = (field: string, label: string) => {
    const value = (money[field] ?? "").trim() === "" ? 0 : parseCents(money[field] ?? "");
    return value === null ? `${label}: informe um valor em R$, como 10,00.` : value;
  };
  const tags = { ...form.tags };
  for (const tag of BENEFIT_TAGS) {
    const discount = cents(`${tag}.discount`, `${BENEFIT_TITLE[tag]} · cupom`);
    const min = cents(`${tag}.min`, `${BENEFIT_TITLE[tag]} · pedido mínimo`);
    if (typeof discount === "string") return { ok: false, error: discount };
    if (typeof min === "string") return { ok: false, error: min };
    tags[tag] = { ...form.tags[tag], discountCents: discount, minOrderCents: min };
  }
  const rDiscount = cents("recovery.discount", "Recuperação · presente");
  const rMin = cents("recovery.min", "Recuperação · pedido mínimo");
  if (typeof rDiscount === "string") return { ok: false, error: rDiscount };
  if (typeof rMin === "string") return { ok: false, error: rMin };
  return { ok: true, body: { tags, recovery: { ...form.recovery, discountCents: rDiscount, minOrderCents: rMin } } };
}

function moneyOf(config: TagBenefitsSettings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of BENEFIT_TAGS) {
    out[`${tag}.discount`] = config.tags[tag].discountCents ? centsText(config.tags[tag].discountCents) : "";
    out[`${tag}.min`] = config.tags[tag].minOrderCents ? centsText(config.tags[tag].minOrderCents) : "";
  }
  out["recovery.discount"] = config.recovery.discountCents ? centsText(config.recovery.discountCents) : "";
  out["recovery.min"] = config.recovery.minOrderCents ? centsText(config.recovery.minOrderCents) : "";
  return out;
}

/**
 * Configurações → Vantagens por tag: cupom e frete grátis de cada tag positiva (o cliente escolhe um por pedido, vale só
 * o melhor) e a recuperação das tags negativas, que o cliente nunca vê.
 */
export function TagBenefitsTab() {
  const { request } = useAuth();
  const tenant = useSettingsTenant();
  const query = useQuery({ queryKey: ["tag-benefits", tenant.id], queryFn: () => request<TagBenefitsSettings>(`/menu/${tenant.id}/tag-benefits`), retry: false });
  if (query.error instanceof ApiError && query.error.status === 403) return <p className="text-ink-3">O módulo Cardápio não está ativo neste restaurante.</p>;
  return query.data ? <BenefitsForm key={tenant.id} tenantId={tenant.id} data={query.data} /> : <TabLoading failed={query.isError} />;
}

const check = "size-4 accent-ink";

function BenefitsForm({ tenantId, data }: { tenantId: string; data: TagBenefitsSettings }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<TagBenefitsSettings>(data);
  const [money, setMoney] = useState<Record<string, string>>(() => moneyOf(data));
  const [failure, setFailure] = useState<string | null>(null);
  const setTag = (tag: BenefitTag, change: Partial<TagBenefitsSettings["tags"][BenefitTag]>) => setForm((f) => ({ ...f, tags: { ...f.tags, [tag]: { ...f.tags[tag], ...change } } }));
  const setRecovery = (change: Partial<TagBenefitsSettings["recovery"]>) => setForm((f) => ({ ...f, recovery: { ...f.recovery, ...change } }));
  const moneyInput = (field: string, placeholder: string) => (
    <Input inputMode="decimal" className="w-28" placeholder={placeholder} value={money[field] ?? ""} onChange={(e) => setMoney((m) => ({ ...m, [field]: e.target.value }))} />
  );

  const [save, saving] = usePendingAction(async () => {
    setFailure(null);
    const result = benefitsPayload(form, money);
    if (!result.ok) return setFailure(result.error);
    try {
      const saved = await request<TagBenefitsSettings>(`/menu/${tenantId}/tag-benefits`, { method: "PUT", body: result.body });
      queryClient.setQueryData(["tag-benefits", tenantId], saved);
      toast("Vantagens salvas");
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível salvar.");
    }
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end gap-3">
        {failure && (
          <p role="alert" className="m-0 text-[12.5px] text-tomate">
            {failure}
          </p>
        )}
        <Button type="button" onClick={save} loading={saving}>
          Salvar
        </Button>
      </div>

      <Card title="Cupons por tag" description="O cliente que entrou no cardápio com o código do WhatsApp vê os cupons das tags dele e escolhe um por pedido (vale só o melhor, não acumula).">
        <CardBody className="flex flex-col divide-y divide-rule-soft">
          {BENEFIT_TAGS.map((tag) => {
            const rule = form.tags[tag];
            return (
              <div key={tag} className="flex flex-col gap-2.5 py-3.5 first:pt-0 last:pb-0">
                <label className="flex items-center gap-2.5">
                  <input type="checkbox" className={check} checked={rule.enabled} onChange={(e) => setTag(tag, { enabled: e.target.checked })} />
                  <span className="font-semibold">{tag}</span>
                  <span className="text-[12px] text-ink-3">· o cliente vê “{BENEFIT_TITLE[tag]}”</span>
                </label>
                <p className="m-0 text-[12px] text-ink-3">{AUTO_TAG_INFO[tag]}</p>
                {rule.enabled && (
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
                    <label className="flex items-center gap-2 text-[13px]">
                      <input type="checkbox" className={check} checked={rule.freeDelivery} onChange={(e) => setTag(tag, { freeDelivery: e.target.checked })} />
                      Entrega grátis
                    </label>
                    <label className="flex items-center gap-2 text-[13px]">
                      Cupom de R$ {moneyInput(`${tag}.discount`, "0,00")}
                    </label>
                    <label className="flex items-center gap-2 text-[13px]">
                      Pedido mínimo R$ {moneyInput(`${tag}.min`, "sem mínimo")}
                    </label>
                    <label className="flex items-center gap-2 text-[13px]">
                      Usar
                      <select
                        className="h-9 rounded-lg border border-rule bg-surface px-2"
                        value={rule.frequency}
                        onChange={(e) => setTag(tag, { frequency: e.target.value as (typeof BENEFIT_FREQUENCIES)[number] })}
                      >
                        {BENEFIT_FREQUENCIES.map((f) => (
                          <option key={f} value={f}>
                            {BENEFIT_FREQUENCY_LABEL[f]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </CardBody>
      </Card>

      <Card
        title="Recuperação (tags negativas)"
        description="Insatisfeito e Em recuperação nunca aparecem para o cliente. O presente entra sozinho no checkout como “Presente da casa”, uma vez a cada 30 dias, e não soma com cupom: vale o maior."
      >
        <CardBody className="flex flex-col gap-3">
          <label className="flex items-center gap-2.5 font-semibold">
            <input type="checkbox" className={check} checked={form.recovery.enabled} onChange={(e) => setRecovery({ enabled: e.target.checked })} />
            Dar um presente no próximo pedido
          </label>
          {form.recovery.enabled && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
              <label className="flex items-center gap-2 text-[13px]">
                Desconto de R$ {moneyInput("recovery.discount", "0,00")}
              </label>
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" className={check} checked={form.recovery.freeDelivery} onChange={(e) => setRecovery({ freeDelivery: e.target.checked })} />
                Entrega grátis
              </label>
              <label className="flex items-center gap-2 text-[13px]">
                Pedido mínimo R$ {moneyInput("recovery.min", "sem mínimo")}
              </label>
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" className={check} checked={form.recovery.sendMessage} onChange={(e) => setRecovery({ sendMessage: e.target.checked })} />
                Avisar o cliente pelo WhatsApp
              </label>
            </div>
          )}
          {form.recovery.enabled && form.recovery.sendMessage && data.recovery.enabled && data.recovery.sendMessage && <RecoveryList tenantId={tenantId} />}
        </CardBody>
      </Card>
    </div>
  );
}

function RecoveryList({ tenantId }: { tenantId: string }) {
  const { request } = useAuth();
  const query = useQuery({ queryKey: ["recovery-contacts", tenantId], queryFn: () => request<RecoveryContact[]>(`/menu/${tenantId}/tag-benefits/recovery-contacts`) });
  if (!query.data) return <TabLoading failed={query.isError} />;
  if (query.data.length === 0) return <p className="m-0 text-ink-3">Nenhum cliente para recuperar agora.</p>;
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-[12.5px] font-semibold text-ink-2">Clientes para recuperar ({query.data.length})</p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {query.data.map((contact) => (
          <RecoveryRow key={contact.contactId} tenantId={tenantId} contact={contact} onSent={() => void query.refetch()} />
        ))}
      </ul>
    </div>
  );
}

function RecoveryRow({ tenantId, contact, onSent }: { tenantId: string; contact: RecoveryContact; onSent: () => void }) {
  const { request } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [send, sending] = usePendingAction(async () => {
    setError(null);
    try {
      await request(`/menu/${tenantId}/tag-benefits/recovery-contacts/${contact.contactId}/message`, { method: "POST" });
      onSent();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível mandar a mensagem.");
    }
  });
  const now = useNow(60_000);
  const recent = contact.lastOfferAt && now - Date.parse(contact.lastOfferAt) < 30 * 24 * 60 * 60_000;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-rule px-3 py-2.5">
      <span className="font-medium">{contact.name ?? "Cliente sem nome"}</span>
      <span className="text-[12px] text-ink-3">{contact.tags.join(", ")}</span>
      <span className="ml-auto flex items-center gap-2">
        {recent ? (
          <span className="text-[12.5px] text-success-ink">Oferta enviada</span>
        ) : !contact.conversationId ? (
          <span className="text-[12.5px] text-ink-3">Sem conversa no WhatsApp</span>
        ) : contact.windowOpen ? (
          <Button size="sm" onClick={send} loading={sending}>
            Mandar oferta
          </Button>
        ) : (
          <span className="text-[12.5px] text-warning-ink">Fora da janela de 24 h: espere o cliente escrever</span>
        )}
      </span>
      {error && <p className="m-0 w-full text-[12px] text-tomate">{error}</p>}
    </li>
  );
}
