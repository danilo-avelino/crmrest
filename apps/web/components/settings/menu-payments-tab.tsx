"use client";

import type { MenuStoreSettings } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { TabLoading, useSettingsTenant } from "@/components/settings/settings-shell";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";
import {
  NO_PAYMENT_METHOD,
  PAY_ON_DELIVERY,
  PIX_EXPIRY_OPTIONS,
  type PaymentsForm,
  type PixForm,
  paymentsChanged,
  paymentsToForm,
  paymentsToPayload,
  pixToForm,
} from "@/lib/menu-payments";
import type { StoreResponse } from "@/lib/menu-store";
import { cn } from "@/lib/utils";

/** Página "Pagamentos do cardápio" (C2): o Pix online (Pagar.me, ligado pela plataforma) e as formas de pagar na entrega ou na retirada. */
export function MenuPaymentsTab() {
  const { request } = useAuth();
  const tenant = useSettingsTenant();
  const query = useQuery({ queryKey: ["menu-store", tenant.id], queryFn: () => request<StoreResponse>(`/menu/${tenant.id}/store`), retry: false });
  if (query.error instanceof ApiError && query.error.status === 403) {
    return <p className="text-ink-3">O módulo Cardápio não está ativo neste restaurante.</p>;
  }
  return query.data ? <MenuPaymentsForm key={tenant.id} tenantId={tenant.id} data={query.data} /> : <TabLoading failed={query.isError} />;
}

/** O selo de estado do design: pílula com o estado escrito ("Aceito" / "Não aceito"). */
function Accept({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
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
      {checked ? "Aceito" : "Não aceito"}
    </button>
  );
}

function MenuPaymentsForm({ tenantId, data }: { tenantId: string; data: StoreResponse }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [store, setStore] = useState<MenuStoreSettings>(data.store);
  const [form, setForm] = useState<PaymentsForm>(() => paymentsToForm(data.store));
  const [pix, setPix] = useState<PixForm>(() => pixToForm(data.store));
  const [failure, setFailure] = useState<string | null>(null);
  const none = !PAY_ON_DELIVERY.some((method) => form[method.id]);
  const changed = paymentsChanged(form, store, pix);
  const pixReady = Boolean(store.pixRecipientId);

  const [save, saving] = usePendingAction(async () => {
    setFailure(null);
    const result = paymentsToPayload(form, store, pix);
    if (!result.ok) return setFailure(result.error);
    try {
      const updated = await request<StoreResponse>(`/menu/${tenantId}/store`, { method: "PUT", body: result.body });
      setStore(updated.store);
      setForm(paymentsToForm(updated.store));
      setPix(pixToForm(updated.store));
      queryClient.setQueryData(["menu-store", tenantId], updated);
      toast("Pagamentos do cardápio salvos");
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Não foi possível salvar.");
    }
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button type="button" onClick={save} loading={saving} disabled={!changed || none}>
          Salvar
        </Button>
      </div>

      <section aria-labelledby="pix-title" className="flex flex-col gap-3 rounded-xl border border-rule bg-surface px-5 py-[18px]">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 flex-none items-center justify-center rounded-md bg-[#E6F4F1] text-[11px] font-bold text-[#0F6B5C]">PIX</span>
          <h3 id="pix-title" className="m-0 flex-1 font-heading text-title font-semibold">
            Pix · pagar agora
          </h3>
          {pixReady ? (
            <span className="inline-flex h-6 items-center gap-1.5 rounded-sm bg-success-lt px-2 text-xs font-semibold text-success-ink">
              <span className="size-1.5 rounded-full bg-success" aria-hidden />
              Conectado
            </span>
          ) : (
            <span className="inline-flex h-6 items-center gap-1.5 rounded-sm bg-surface-2 px-2 text-xs font-semibold text-ink-2">
              <span className="size-1.5 rounded-full bg-ink-3" aria-hidden />
              Não configurado
            </span>
          )}
        </div>
        {pixReady ? (
          <>
            <div className="flex items-center gap-2.5">
              <span className="flex-1">
                <span className="block font-medium">Aceitar Pix no cardápio</span>
                <span className="text-xs text-ink-3">QR Code e copia e cola na hora do pedido; o dinheiro cai na conta do restaurante pela Pagar.me</span>
              </span>
              <Accept checked={pix.accept} onChange={(value) => setPix((current) => ({ ...current, accept: value }))} label="Aceitar Pix no cardápio" />
            </div>
            <div className="flex flex-col gap-[5px]">
              <label htmlFor="pix-validity" className="font-medium">
                Validade do Pix
              </label>
              <div className="flex items-center gap-2">
                <select
                  id="pix-validity"
                  value={pix.expiresMinutes}
                  onChange={(e) => setPix((current) => ({ ...current, expiresMinutes: Number(e.target.value) }))}
                  disabled={!pix.accept}
                  className="h-9 w-[100px] rounded-lg border border-rule bg-surface px-2.5 tabular-nums outline-none focus:border-ink disabled:opacity-55"
                >
                  {PIX_EXPIRY_OPTIONS.map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {minutes}
                    </option>
                  ))}
                </select>
                <span className="text-ink-2">minutos</span>
              </div>
              <p className="m-0 text-xs text-ink-3">O pedido só entra depois que o pagamento é confirmado. Vencido, o cliente gera outro Pix.</p>
            </div>
          </>
        ) : (
          <p className="m-0 text-ink-2">
            A conta Pagar.me do restaurante é ligada pela equipe do Dish Desk: o dinheiro cai direto na conta que vocês escolherem. Peça pelo suporte. Enquanto isso, o cliente paga
            só na entrega ou na retirada.
          </p>
        )}
      </section>

      <section
        aria-labelledby="pay-later-title"
        className={cn("flex flex-col gap-1 rounded-xl border bg-surface px-5 py-[18px]", none || failure === NO_PAYMENT_METHOD ? "border-tomate" : "border-rule")}
      >
        <h3 id="pay-later-title" className="m-0 font-heading text-title font-semibold">
          Pagar na entrega ou na retirada
        </h3>
        {PAY_ON_DELIVERY.map((method) => (
          <div key={method.id} className="flex items-center gap-2.5 border-t border-rule-soft py-2.5 first-of-type:border-t-0">
            <span className="flex-1">
              <span className="block font-medium">{method.name}</span>
              <span className="text-xs text-ink-3">{method.note}</span>
            </span>
            <Accept checked={form[method.id]} onChange={(value) => setForm((current) => ({ ...current, [method.id]: value }))} label={method.name} />
          </div>
        ))}
        {(none || failure) && (
          <p role="alert" className="m-0 pt-1 text-[12px] text-tomate">
            {none ? NO_PAYMENT_METHOD : failure}
          </p>
        )}
      </section>
    </div>
  );
}
