"use client";

import { useState } from "react";
import { moneyShort, PAYMENT_LABELS, type PublicMenuStore, weekHoursRows } from "@/lib/public-menu";
import { Sheet } from "./sheet";

/** "Mais informações" (W19), com o que a API pública já entrega: entrega, taxas e formas de pagamento. */
export function StoreInfoButton({ store, className }: { store: PublicMenuStore; className?: string }) {
  const [open, setOpen] = useState(false);
  const { feeRange, deliveryEta, minOrderCents, freeDeliveryFromCents } = store;
  const rows: [string, string][] = [];
  if (deliveryEta.maxMinutes > 0) {
    rows.push(["Tempo médio", deliveryEta.minMinutes === deliveryEta.maxMinutes ? `${deliveryEta.maxMinutes} min` : `${deliveryEta.minMinutes}–${deliveryEta.maxMinutes} min`]);
  }
  rows.push(["Pedido mínimo", minOrderCents > 0 ? moneyShort(minOrderCents) : "Sem mínimo"]);
  if (feeRange) rows.push(["Taxa de entrega", feeRange.minCents === feeRange.maxCents ? moneyShort(feeRange.minCents) : `${moneyShort(feeRange.minCents)} a ${moneyShort(feeRange.maxCents)}`]);
  rows.push(["Retirada no balcão", store.pickupEnabled ? "Disponível" : "Não disponível"]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className ?? "text-[13px] font-medium underline underline-offset-[3px]"}>
        Mais informações
      </button>
      {open && (
        <Sheet title="Sobre a loja" onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-3 p-4">
            <h3 className="m-0 font-heading text-[22px] leading-tight font-bold tracking-[-0.4px]">{store.name}</h3>
            <StatusLine store={store} />
            {store.about && <p className="m-0 text-ink-2">{store.about}</p>}
            {store.weekHours && (
              <section className="flex flex-col gap-2 rounded-xl border border-rule bg-surface p-3">
                <h4 className="m-0 font-heading text-title font-semibold">Horário</h4>
                <dl className="m-0 flex flex-col">
                  {weekHoursRows(store.weekHours).map(([day, value]) => (
                    <div key={day} className="flex min-h-8 items-center justify-between border-t border-rule-soft first:border-t-0">
                      <dt className="text-ink-2">{day}</dt>
                      <dd className="m-0 font-medium tabular-nums">{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
            <section className="flex flex-col gap-2 rounded-xl border border-rule bg-surface p-3">
              <h4 className="m-0 font-heading text-title font-semibold">Entrega</h4>
              <dl className="m-0 flex flex-col">
                {rows.map(([label, value]) => (
                  <div key={label} className="flex min-h-8 items-center justify-between border-t border-rule-soft first:border-t-0">
                    <dt className="text-ink-2">{label}</dt>
                    <dd className="m-0 font-medium tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
              {freeDeliveryFromCents != null && (
                <div className="rounded-lg bg-success-lt px-2.5 py-2 font-medium text-success-ink">Entrega grátis em pedidos acima de {moneyShort(freeDeliveryFromCents)}</div>
              )}
            </section>
            <section className="flex flex-col gap-2 rounded-xl border border-rule bg-surface p-3">
              <h4 className="m-0 font-heading text-title font-semibold">Formas de pagamento</h4>
              <ul className="m-0 flex list-none flex-col p-0">
                {store.paymentMethods.map((method) => (
                  <li key={method} className="flex min-h-8 items-center border-t border-rule-soft font-medium first:border-t-0">
                    {PAYMENT_LABELS[method]}
                  </li>
                ))}
              </ul>
            </section>
            {(store.address || store.phone || store.cnpj) && (
              <section className="flex flex-col gap-1 rounded-xl border border-rule bg-surface p-3">
                <h4 className="m-0 font-heading text-title font-semibold">Contato</h4>
                {store.address && <div className="text-ink-2">{[store.address, store.city].filter(Boolean).join(" · ")}</div>}
                {store.phone && (
                  <a href={`tel:${store.phone.replace(/[^\d+]/g, "")}`} className="font-medium tabular-nums underline underline-offset-[3px]">
                    {store.phone}
                  </a>
                )}
                {store.cnpj && <div className="text-[12px] text-ink-3 tabular-nums">CNPJ {store.cnpj}</div>}
              </section>
            )}
            <p className="m-0 text-center text-[12px] text-ink-3">
              Feito com <span className="font-semibold text-ink-2">Dish Desk</span>
            </p>
          </div>
        </Sheet>
      )}
    </>
  );
}

/** Estado da loja em forma e texto (regra 3): bolinha cheia verde, vazada ou pausa, sempre com o texto ao lado. */
export function StatusLine({ store }: { store: PublicMenuStore }) {
  if (store.status === "open") {
    return (
      <div className="flex items-center gap-2 font-medium text-success-ink">
        <span className="size-2.5 rounded-full bg-success" aria-hidden="true" />
        {store.closesAt ? `Aberto agora · fecha às ${store.closesAt}` : "Aberto agora"}
      </div>
    );
  }
  if (store.status === "paused") {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-warning-line bg-warning-lt px-3 py-2.5 font-medium text-warning-ink">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M9 5v14M15 5v14" />
        </svg>
        Pausado agora, volte em instantes
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-rule bg-surface px-3 py-2.5 font-medium">
      <span className="box-border size-2.5 rounded-full border-2 border-ink-3" aria-hidden="true" />
      {store.nextOpening ? `Fechado · Abre ${store.nextOpening}` : "Fechado agora"}
    </div>
  );
}
