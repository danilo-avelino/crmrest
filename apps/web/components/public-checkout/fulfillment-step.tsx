"use client";

import { CalendarIcon, ShoppingBagIcon, TruckIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  arrivalWindow,
  type CheckoutMode,
  type CheckoutWhen,
  dayLabel,
  etaLabel,
  fetchQuote,
  fetchSlots,
  type Quote,
  type Slot,
  slotStart,
  whenLabel,
} from "@/lib/public-checkout";
import { moneyShort, type PublicMenuStore } from "@/lib/public-menu";
import { cn } from "@/lib/utils";
import { AccentButton, CheckoutFooter, CheckoutHeader, RadioDot } from "./ui";

type SlotsState = { kind: "loading" } | { kind: "error" } | { kind: "ok"; slots: Slot[] };

/**
 * Entrega ou retirada e quando (W9, R2, R13). Dois cartões lado a lado sem sobreposição em 360 px; "Agora" só com a
 * loja aberta; "Agendar" abre as faixas de hoje e amanhã (GET /slots). Loja fechada: só agendar.
 */
export function FulfillmentStep({
  slug,
  store,
  subtotalCents,
  mode: savedMode,
  when: savedWhen,
  scheduleRequested,
  identityLine,
  onBack,
  onContinue,
}: {
  slug: string;
  store: PublicMenuStore;
  subtotalCents: number;
  mode: CheckoutMode | null;
  when: CheckoutWhen | null;
  /** `?agendar=1` da sacola (loja fechada): abre já em "Agendar". */
  scheduleRequested: boolean;
  identityLine: React.ReactNode;
  onBack: () => void;
  onContinue: (choice: { mode: CheckoutMode; when: CheckoutWhen; quote: Quote | null }) => void;
}) {
  const open = store.status === "open";
  const canSchedule = store.schedulingEnabled;
  const [mode, setMode] = useState<CheckoutMode>(savedMode === "PICKUP" && store.pickupEnabled ? "PICKUP" : "DELIVERY");
  const [whenKind, setWhenKind] = useState<"now" | "scheduled">(() => {
    if (!open) return "scheduled";
    if (scheduleRequested && canSchedule) return "scheduled";
    return savedWhen?.kind === "scheduled" && canSchedule ? "scheduled" : "now";
  });
  const [slot, setSlot] = useState<Slot | null>(savedWhen?.kind === "scheduled" ? savedWhen.slot : null);
  const [day, setDay] = useState<"today" | "tomorrow">(savedWhen?.kind === "scheduled" ? savedWhen.slot.day : "today");
  const [slots, setSlots] = useState<SlotsState>({ kind: "loading" });
  const [slotsTry, setSlotsTry] = useState(0);
  const [pickup, setPickup] = useState<Quote | null>(null);
  const [now] = useState(() => new Date());

  useEffect(() => {
    if (!canSchedule) return;
    let alive = true;
    fetchSlots(slug)
      .then((list) => alive && setSlots({ kind: "ok", slots: list }))
      .catch(() => alive && setSlots({ kind: "error" }));
    return () => {
      alive = false;
    };
  }, [slug, canSchedule, slotsTry]);

  useEffect(() => {
    if (!store.pickupEnabled) return;
    let alive = true;
    fetchQuote(slug, { mode: "PICKUP", subtotalCents })
      .then((q) => alive && q.ok && setPickup({ feeCents: 0, eta: q.eta, freeDelivery: false }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [slug, store.pickupEnabled, subtotalCents]);

  const list = useMemo(() => (slots.kind === "ok" ? slots.slots : []), [slots]);
  const days = useMemo(() => (["today", "tomorrow"] as const).filter((d) => list.some((s) => s.day === d)), [list]);
  const shownDay = days.includes(day) ? day : (days[0] ?? "today");
  // Faixa guardada que saiu da lista (passou da hora): não vale mais.
  const chosen = slot && list.some((s) => s.start === slot.start) ? slot : null;
  const eta = mode === "PICKUP" ? (pickup?.eta ?? null) : store.deliveryEta;
  const slotMinutes = list[0] ? Math.round((Date.parse(list[0].end) - Date.parse(list[0].start)) / 60_000) : null;

  const blocked = store.status === "paused" || (!open && !canSchedule);
  const ready = !blocked && (whenKind === "now" ? open : chosen != null);
  const cta = whenKind === "scheduled" && chosen ? `Continuar · ${whenLabel(chosen)}` : "Continuar";

  const fee = store.feeRange
    ? store.feeRange.minCents === store.feeRange.maxCents
      ? moneyShort(store.feeRange.minCents)
      : `${moneyShort(store.feeRange.minCents)} a ${moneyShort(store.feeRange.maxCents)}`
    : "Taxa pelo endereço";

  return (
    <>
      <CheckoutHeader title="Como você quer receber?" onBack={onBack} step={1} />
      <div className="flex flex-col gap-3 px-3 py-4 pb-32">
        {identityLine}
        {store.status === "paused" && (
          <Notice>
            <span className="font-semibold">A loja pausou os pedidos por enquanto.</span> Sua sacola fica guardada.
          </Notice>
        )}
        {store.status === "closed" && (
          <Notice>
            <span className="font-semibold">Fechado agora{store.nextOpening ? ` · abre ${store.nextOpening}` : ""}.</span>{" "}
            {canSchedule ? "Escolha um horário e o pedido entra assim que a loja abrir." : "Esta loja não aceita pedidos agendados."}
          </Notice>
        )}

        <div role="radiogroup" aria-label="Modo de recebimento" className="grid grid-cols-2 gap-2.5">
          <ModeCard
            on={mode === "DELIVERY"}
            onSelect={() => setMode("DELIVERY")}
            icon={<TruckIcon className="size-[22px]" strokeWidth={1.8} aria-hidden />}
            title="Entrega"
            lines={[fee, etaLabel(store.deliveryEta)]}
            wide={!store.pickupEnabled}
          />
          {store.pickupEnabled && (
            <ModeCard
              on={mode === "PICKUP"}
              onSelect={() => setMode("PICKUP")}
              icon={<ShoppingBagIcon className="size-[22px]" strokeWidth={1.8} aria-hidden />}
              title="Retirada"
              lines={[`${store.address ?? "Na loja"} · grátis`, pickup ? `pronto em ${etaLabel(pickup.eta)}` : "pronto no preparo"]}
            />
          )}
        </div>

        <section className="flex flex-col gap-2.5 rounded-xl border border-rule bg-surface px-3 py-3.5" aria-labelledby="when-title">
          <h2 id="when-title" className="m-0 font-heading text-title font-semibold">
            Quando?
          </h2>
          <div role="radiogroup" aria-label="Quando" className="flex flex-col gap-2">
            {open && (
              <button
                type="button"
                role="radio"
                aria-checked={whenKind === "now"}
                onClick={() => setWhenKind("now")}
                className={cn("flex min-h-[52px] items-center gap-2.5 rounded-lg bg-surface px-3 text-left", whenKind === "now" ? "border-2 border-ink" : "border border-rule")}
              >
                <RadioDot on={whenKind === "now"} />
                <span className="flex-1">
                  <span className="block font-medium">Agora</span>
                  {eta && (
                    <span className="block text-[12px] text-ink-3">
                      {mode === "PICKUP" ? "pronto" : "chega"} {arrivalWindow(eta, now)}
                    </span>
                  )}
                </span>
                {eta && <span className="font-semibold tabular-nums">{etaLabel(eta)}</span>}
              </button>
            )}
            {canSchedule && (
              <button
                type="button"
                role="radio"
                aria-checked={whenKind === "scheduled"}
                onClick={() => setWhenKind("scheduled")}
                className={cn("flex min-h-[52px] items-center gap-2.5 rounded-lg bg-surface px-3 text-left", whenKind === "scheduled" ? "border-2 border-ink" : "border border-rule")}
              >
                <RadioDot on={whenKind === "scheduled"} />
                <span className="flex-1 font-medium">Agendar</span>
                <CalendarIcon className="size-[18px] text-ink-2" strokeWidth={1.8} aria-hidden />
              </button>
            )}
          </div>

          {whenKind === "scheduled" && canSchedule && (
            <div className="flex flex-col gap-2.5 pt-1">
              {slots.kind === "loading" && <div className="h-[100px] animate-pulse rounded-lg bg-surface-2" aria-label="Carregando horários" />}
              {slots.kind === "error" && (
                <div role="alert" className="flex items-center justify-between gap-2 text-tomate">
                  <span className="font-medium">Não conseguimos carregar os horários.</span>
                  <Button variant="outline" size="sm" onClick={() => (setSlots({ kind: "loading" }), setSlotsTry((n) => n + 1))}>
                    Tentar de novo
                  </Button>
                </div>
              )}
              {slots.kind === "ok" && list.length === 0 && <p className="m-0 text-ink-2">Não há horários para hoje nem amanhã.</p>}
              {list.length > 0 && (
                <>
                  <div className="flex gap-2">
                    {days.map((d) => (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={shownDay === d}
                        onClick={() => setDay(d)}
                        className={cn("h-10 flex-1 rounded-lg font-medium", shownDay === d ? "bg-ink text-paper" : "border border-rule bg-surface text-ink")}
                      >
                        {dayLabel(d, now)}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {list
                      .filter((s) => s.day === shownDay)
                      .map((s) => {
                        const on = chosen?.start === s.start;
                        return (
                          <button
                            key={s.start}
                            type="button"
                            aria-pressed={on}
                            aria-label={`${dayLabel(s.day, now)}, ${s.label}`}
                            onClick={() => {
                              setSlot(s);
                              setDay(s.day);
                            }}
                            className={cn("h-11 rounded-lg font-medium tabular-nums", on ? "bg-ink text-paper" : "border border-rule bg-surface text-ink")}
                          >
                            {slotStart(s)}
                          </button>
                        );
                      })}
                  </div>
                  {slotMinutes != null && <div className="text-[12px] text-ink-3">Faixas de {slotMinutes} min. O pedido chega dentro da faixa escolhida.</div>}
                </>
              )}
            </div>
          )}
        </section>
      </div>

      <CheckoutFooter>
        {!ready && !blocked && whenKind === "scheduled" && <p className="m-0 mb-2 text-[12px] text-ink-2">Escolha um horário para continuar.</p>}
        <AccentButton
          disabled={!ready}
          onClick={async () => {
            const when: CheckoutWhen = whenKind === "scheduled" && chosen ? { kind: "scheduled", slot: chosen } : { kind: "now" };
            let quote: Quote | null = null;
            if (mode === "PICKUP") {
              quote = pickup;
              if (!quote) {
                const q = await fetchQuote(slug, { mode: "PICKUP", subtotalCents }).catch(() => null);
                quote = q?.ok ? { feeCents: 0, eta: q.eta, freeDelivery: false } : null;
              }
            }
            onContinue({ mode, when, quote });
          }}
        >
          {cta}
        </AccentButton>
      </CheckoutFooter>
    </>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" className="flex items-center gap-2.5 rounded-xl border border-rule bg-surface px-3 py-2.5">
      <span aria-hidden className="size-2.5 flex-none rounded-full border-2 border-ink-3" />
      <span>{children}</span>
    </div>
  );
}

function ModeCard({
  on,
  onSelect,
  icon,
  title,
  lines,
  wide,
}: {
  on: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  lines: string[];
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onSelect}
      className={cn(
        "flex min-h-[132px] min-w-0 flex-col gap-1.5 rounded-xl bg-surface px-3 py-3.5 text-left",
        on ? "border-2 border-ink" : "border border-rule",
        wide && "col-span-2",
      )}
    >
      <span className="flex w-full items-center justify-between">
        {icon}
        <RadioDot on={on} />
      </span>
      <span className="text-[15px] font-semibold">{title}</span>
      {lines.map((line) => (
        <span key={line} className="text-[12px] break-words text-ink-2">
          {line}
        </span>
      ))}
    </button>
  );
}
