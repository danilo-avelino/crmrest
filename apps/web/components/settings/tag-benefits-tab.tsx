"use client";

import {
  AUTO_TAG_INFO,
  BENEFIT_FREQUENCIES,
  BENEFIT_PER_MONTH_MAX,
  BENEFIT_PER_MONTH_MIN,
  BENEFIT_FREQUENCY_LABEL,
  BENEFIT_TAGS,
  BENEFIT_TITLE,
  type BenefitFrequency,
  type BenefitTag,
  type TagBenefit,
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
import { centsText, type MenuTree, parseCents } from "@/lib/menu";

type RecoveryContact = { contactId: string; name: string | null; phone: string | null; tags: string[]; conversationId: string | null; windowOpen: boolean; lastOfferAt: string | null };

/**
 * Campos em texto (R$) para o corpo do PUT; devolve a mensagem do primeiro valor inválido. Cada tag tem os campos
 * `VIP.discount`, `VIP.discountMin`, `VIP.freeDeliveryMin` e `VIP.giftMin`.
 */
export function benefitsPayload(form: TagBenefitsSettings, money: Record<string, string>): { ok: true; body: TagBenefitsSettings } | { ok: false; error: string } {
  const cents = (field: string, label: string) => {
    const value = (money[field] ?? "").trim() === "" ? 0 : parseCents(money[field] ?? "");
    return value === null ? `${label}: informe um valor em R$, como 10,00.` : value;
  };
  const tags = { ...form.tags };
  for (const tag of BENEFIT_TAGS) {
    const rule = form.tags[tag];
    const title = BENEFIT_TITLE[tag];
    const discount = rule.discount.enabled ? cents(`${tag}.discount`, `${title} · cupom`) : 0;
    const discountMin = cents(`${tag}.discountMin`, `${title} · cupom · pedido mínimo`);
    const freeMin = cents(`${tag}.freeDeliveryMin`, `${title} · entrega grátis · pedido mínimo`);
    const giftMin = cents(`${tag}.giftMin`, `${title} · brinde · pedido mínimo`);
    for (const value of [discount, discountMin, freeMin, giftMin]) if (typeof value === "string") return { ok: false, error: value };
    if (rule.enabled && rule.discount.enabled && discount === 0) return { ok: false, error: `${title} · cupom: informe o valor ou desmarque a caixa.` };
    if (rule.enabled && rule.gift.enabled && !rule.gift.itemId) return { ok: false, error: `${title} · brinde: escolha o item ou desmarque a caixa.` };
    tags[tag] = {
      ...rule,
      freeDelivery: { ...rule.freeDelivery, minOrderCents: freeMin as number },
      discount: { ...rule.discount, cents: discount as number, minOrderCents: discountMin as number },
      gift: { ...rule.gift, minOrderCents: giftMin as number },
    };
  }
  const rDiscount = cents("recovery.discount", "Recuperação · presente");
  const rMin = cents("recovery.min", "Recuperação · pedido mínimo");
  if (typeof rDiscount === "string") return { ok: false, error: rDiscount };
  if (typeof rMin === "string") return { ok: false, error: rMin };
  return { ok: true, body: { tags, recovery: { ...form.recovery, discountCents: rDiscount, minOrderCents: rMin } } };
}

function moneyOf(config: TagBenefitsSettings): Record<string, string> {
  const out: Record<string, string> = {};
  const text = (value: number) => (value ? centsText(value) : "");
  for (const tag of BENEFIT_TAGS) {
    const rule = config.tags[tag];
    out[`${tag}.discount`] = text(rule.discount.cents);
    out[`${tag}.discountMin`] = text(rule.discount.minOrderCents);
    out[`${tag}.freeDeliveryMin`] = text(rule.freeDelivery.minOrderCents);
    out[`${tag}.giftMin`] = text(rule.gift.minOrderCents);
  }
  out["recovery.discount"] = text(config.recovery.discountCents);
  out["recovery.min"] = text(config.recovery.minOrderCents);
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
// Títulos das tags e das vantagens: só o checkbox liga e desliga (clicar no resto da linha não mexe em nada).
// min-w-0 e flex-1: o seletor encolhe com a caixa em vez de vazar para fora dela.
const select = "h-9 min-w-0 flex-1 rounded-lg border border-rule bg-surface px-2";
/** Caixa de cada vantagem: marcada, borda ink; desmarcada, borda rule. */
const box = (on: boolean) => `flex min-w-0 flex-col gap-2 rounded-lg border px-3 py-2.5 text-[13px] ${on ? "border-ink bg-surface" : "border-rule bg-paper"}`;
const clampPerMonth = (value: string) => Math.min(BENEFIT_PER_MONTH_MAX, Math.max(BENEFIT_PER_MONTH_MIN, Number(value) || BENEFIT_PER_MONTH_MIN));

/** "N vezes por mês": aparece quando a vantagem vale em X pedidos por mês. */
function PerMonthInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <Input type="number" min={BENEFIT_PER_MONTH_MIN} max={BENEFIT_PER_MONTH_MAX} className="w-20 tabular-nums" value={value} onChange={(e) => onChange(clampPerMonth(e.target.value))} />
      vezes por mês
    </label>
  );
}

function BenefitsForm({ tenantId, data }: { tenantId: string; data: TagBenefitsSettings }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<TagBenefitsSettings>(data);
  const [money, setMoney] = useState<Record<string, string>>(() => moneyOf(data));
  const [failure, setFailure] = useState<string | null>(null);
  const setTag = (tag: BenefitTag, change: Partial<TagBenefit>) => setForm((f) => ({ ...f, tags: { ...f.tags, [tag]: { ...f.tags[tag], ...change } } }));
  /** Muda uma parte da tag (entrega grátis, cupom ou brinde). */
  const setPerk = <K extends "freeDelivery" | "discount" | "gift">(tag: BenefitTag, perk: K, change: Partial<TagBenefit[K]>) =>
    setForm((f) => ({ ...f, tags: { ...f.tags, [tag]: { ...f.tags[tag], [perk]: { ...f.tags[tag][perk], ...change } } } }));
  const setRecovery = (change: Partial<TagBenefitsSettings["recovery"]>) => setForm((f) => ({ ...f, recovery: { ...f.recovery, ...change } }));
  const menu = useQuery({ queryKey: ["menu", tenantId], queryFn: () => request<MenuTree>(`/menu/${tenantId}`) });
  const moneyInput = (field: string, placeholder: string, disabled = false) => (
    <Input
      inputMode="decimal"
      className="w-28"
      placeholder={placeholder}
      disabled={disabled}
      value={money[field] ?? ""}
      onChange={(e) => setMoney((m) => ({ ...m, [field]: e.target.value }))}
    />
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

      <Card
        title="Vantagens por tag"
        description="O cliente que entrou no cardápio com o código do WhatsApp vê os cupons das tags dele e escolhe um por pedido (vale só o melhor, não acumula). Em cada tag, a entrega grátis, o cupom e o brinde têm o seu próprio pedido mínimo e a sua frequência."
      >
        <CardBody className="flex flex-col divide-y divide-rule-soft">
          {BENEFIT_TAGS.map((tag) => {
            const rule = form.tags[tag];
            const frequency = (perk: "freeDelivery" | "discount") => (
              <>
                <label className="flex min-w-0 items-center gap-2 text-[13px]">
                  Usar
                  <select className={select} value={rule[perk].frequency} onChange={(e) => setPerk(tag, perk, { frequency: e.target.value as BenefitFrequency })}>
                    {BENEFIT_FREQUENCIES.map((f) => (
                      <option key={f} value={f}>
                        {BENEFIT_FREQUENCY_LABEL[f]}
                      </option>
                    ))}
                  </select>
                </label>
                {rule[perk].frequency === "MONTHLY_TIMES" && <PerMonthInput value={rule[perk].perMonth} onChange={(value) => setPerk(tag, perk, { perMonth: value })} />}
              </>
            );
            return (
              <div key={tag} className="flex flex-col gap-2.5 py-3.5 first:pt-0 last:pb-0">
                <div className="flex items-center gap-2.5">
                  <input type="checkbox" aria-label={`Vantagens da tag ${tag}`} className={check} checked={rule.enabled} onChange={(e) => setTag(tag, { enabled: e.target.checked })} />
                  <span className="font-semibold">{tag}</span>
                  <span className="text-[12px] text-ink-3">· o cliente vê “{BENEFIT_TITLE[tag]}”</span>
                </div>
                <p className="m-0 text-[12px] text-ink-3">{AUTO_TAG_INFO[tag]}</p>
                {rule.enabled && (
                  <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-3">
                    <div className={box(rule.freeDelivery.enabled)}>
                      <div className="flex items-center gap-2 font-medium">
                        <input type="checkbox" aria-label={`Entrega grátis da tag ${tag}`} className={check} checked={rule.freeDelivery.enabled} onChange={(e) => setPerk(tag, "freeDelivery", { enabled: e.target.checked })} />
                        Entrega grátis
                      </div>
                      <span className="text-[12px] text-ink-3">A taxa de entrega sai do pedido.</span>
                      {rule.freeDelivery.enabled && (
                        <>
                          <label className="flex items-center gap-2 text-[13px]">Pedido mínimo R$ {moneyInput(`${tag}.freeDeliveryMin`, "sem mínimo")}</label>
                          {frequency("freeDelivery")}
                        </>
                      )}
                    </div>

                    <div className={box(rule.discount.enabled)}>
                      <div className="flex items-center gap-2 font-medium">
                        <input type="checkbox" aria-label={`Cupom de desconto da tag ${tag}`} className={check} checked={rule.discount.enabled} onChange={(e) => setPerk(tag, "discount", { enabled: e.target.checked })} />
                        Cupom de desconto
                      </div>
                      <span className="text-[12px] text-ink-3">Valor em R$ que sai do pedido.</span>
                      {rule.discount.enabled && (
                        <>
                          <label className="flex items-center gap-2 text-[13px]">Desconto R$ {moneyInput(`${tag}.discount`, "0,00")}</label>
                          <label className="flex items-center gap-2 text-[13px]">Pedido mínimo R$ {moneyInput(`${tag}.discountMin`, "sem mínimo")}</label>
                          {frequency("discount")}
                        </>
                      )}
                    </div>

                    <div className={box(rule.gift.enabled)}>
                      <div className="flex items-center gap-2 font-medium">
                        <input type="checkbox" aria-label={`Brinde do cardápio da tag ${tag}`} className={check} checked={rule.gift.enabled} onChange={(e) => setPerk(tag, "gift", { enabled: e.target.checked })} />
                        Brinde do cardápio
                      </div>
                      <span className="text-[12px] text-ink-3">Entra sozinho no carrinho, de graça. Soma com o cupom; um brinde por pedido.</span>
                      {rule.gift.enabled && (
                        <>
                          <label className="flex min-w-0 items-center gap-2 text-[13px]">
                            Item
                            <select className={select} value={rule.gift.itemId ?? ""} onChange={(e) => setPerk(tag, "gift", { itemId: e.target.value || null })}>
                              <option value="">Escolha o item</option>
                              {menu.data?.categories.map((category) => (
                                <optgroup key={category.id} label={category.name}>
                                  {category.items
                                    .filter((item) => item.active || item.id === rule.gift.itemId)
                                    .map((item) => (
                                      <option key={item.id} value={item.id}>
                                        {item.name}
                                        {item.soldOut ? " (esgotado)" : ""}
                                      </option>
                                    ))}
                                </optgroup>
                              ))}
                            </select>
                          </label>
                          <label className="flex items-center gap-2 text-[13px]">Pedido mínimo R$ {moneyInput(`${tag}.giftMin`, "sem mínimo")}</label>
                          <label className="flex min-w-0 items-center gap-2 text-[13px]">
                            Limite
                            <select
                              className={select}
                              value={rule.gift.perMonth == null ? "none" : rule.gift.perMonth === 1 ? "once" : "many"}
                              onChange={(e) => setPerk(tag, "gift", { perMonth: e.target.value === "none" ? null : e.target.value === "once" ? 1 : 2 })}
                            >
                              <option value="none">Sem limite</option>
                              <option value="once">Uma vez por mês</option>
                              <option value="many">Em X pedidos por mês</option>
                            </select>
                          </label>
                          {rule.gift.perMonth != null && rule.gift.perMonth > 1 && <PerMonthInput value={rule.gift.perMonth} onChange={(value) => setPerk(tag, "gift", { perMonth: value })} />}
                        </>
                      )}
                    </div>
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
