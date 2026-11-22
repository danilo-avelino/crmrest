"use client";

import { PlusIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { BLOCK, WarnNote } from "@/components/menu/bits";
import { buttonVariants, Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clockText, hoursLabel, type Range, rangesToSlots, type StoreDay, WEEK_ORDER, WEEKDAY_LETTER, WEEKDAY_SHORT, weeklyMinutes } from "@/lib/menu";
import { cn } from "@/lib/utils";

export type AvailabilityDraft = { restricted: boolean; ranges: Range[] };

const MODES = [
  { restricted: false, name: "Sempre que a loja estiver aberta", note: "O padrão de todos os itens" },
  { restricted: true, name: "Só em dias e horários escolhidos", note: "Ex.: prato executivo, café da manhã" },
];

const newRange = (): Range => ({ key: `n${Date.now()}${Math.random()}`, days: [1, 2, 3, 4, 5], from: "11:00", to: "15:00" });

const storeLabel = (shifts: StoreDay | undefined) => (!shifts?.length ? "Fechado" : shifts.map((shift) => `${shift.open.replace(":00", "")}–${shift.close.replace(":00", "")}`).join(" "));

/** P4: dias da semana e faixas de horário do item, com o aviso quando ele nunca aparece no horário da loja. */
export function AvailabilityEditor({ value, onChange, store }: { value: AvailabilityDraft; onChange: (value: AvailabilityDraft) => void; store: StoreDay[] | null }) {
  const parsed = rangesToSlots(value.ranges);
  const slots = "slots" in parsed ? parsed.slots : null;
  const minutes = slots && value.restricted ? weeklyMinutes(slots, store) : null;
  const never = value.restricted && slots !== null && slots.length > 0 && store !== null && minutes === 0;
  const setRange = (key: string, patch: Partial<Range>) => onChange({ ...value, ranges: value.ranges.map((range) => (range.key === key ? { ...range, ...patch } : range)) });

  return (
    <div className="flex flex-col gap-4">
      <section className={cn(BLOCK, "flex flex-col gap-3 p-5")}>
        <h2 className="font-heading text-title font-semibold">Quando este item aparece</h2>
        <div role="radiogroup" aria-label="Quando este item aparece" className="grid grid-cols-2 gap-3">
          {MODES.map((mode) => {
            const on = value.restricted === mode.restricted;
            return (
              <button
                key={mode.name}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange({ restricted: mode.restricted, ranges: mode.restricted && value.ranges.length === 0 ? [newRange()] : value.ranges })}
                className={cn("flex items-start gap-3 rounded-lg px-3.5 py-3 text-left", on ? "border-[1.5px] border-ink" : "border border-rule")}
              >
                <span className={cn("mt-0.5 size-[18px] shrink-0 rounded-full", on ? "border-[6px] border-ink" : "border-2 border-[#C4BDB2]")} />
                <span>
                  <span className="block font-medium">{mode.name}</span>
                  <span className="block text-xs text-ink-3">{mode.note}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {value.restricted && (
        <section className={cn(BLOCK, "flex flex-col gap-3 p-5")}>
          <div className="flex items-baseline justify-between">
            <h2 className="font-heading text-title font-semibold">Faixas de horário</h2>
            {minutes !== null && <span className="text-ink-2 tabular-nums">{hoursLabel(minutes)}</span>}
          </div>
          {value.ranges.map((range) => (
            <div key={range.key} className={cn("flex flex-col gap-2 rounded-lg border p-3", never ? "border-warning-line" : "border-rule-soft")}>
              <div className="flex flex-wrap items-center gap-4">
                <fieldset className="flex items-center gap-1">
                  <legend className="sr-only">Dias da semana</legend>
                  {WEEK_ORDER.map((day) => {
                    const on = range.days.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        aria-pressed={on}
                        aria-label={WEEKDAY_SHORT[day]}
                        onClick={() => setRange(range.key, { days: on ? range.days.filter((d) => d !== day) : [...range.days, day] })}
                        className={cn("size-8 rounded-lg border text-[12.5px] font-medium", on ? "border-ink bg-ink text-paper" : "border-rule bg-surface text-ink-2")}
                      >
                        {WEEKDAY_LETTER[day]}
                      </button>
                    );
                  })}
                </fieldset>
                <div className="flex items-center gap-2">
                  <label htmlFor={`de-${range.key}`}>das</label>
                  <Input id={`de-${range.key}`} value={range.from} onChange={(event) => setRange(range.key, { from: event.target.value })} placeholder="11:00" className="w-20 tabular-nums" />
                  <label htmlFor={`ate-${range.key}`}>às</label>
                  <Input id={`ate-${range.key}`} value={range.to} onChange={(event) => setRange(range.key, { to: event.target.value })} placeholder="15:00" className="w-20 tabular-nums" />
                </div>
                <Button variant="ghost" size="icon" aria-label="Remover faixa" onClick={() => onChange({ ...value, ranges: value.ranges.filter((other) => other.key !== range.key) })} className="ml-auto">
                  <XIcon />
                </Button>
              </div>
              {never && range === value.ranges[0] && (
                <div role="alert">
                  <WarnNote
                    action={
                      <Link href="/configuracoes/horario" className={buttonVariants({ variant: "outline", size: "sm" })}>
                        Ajustar horário da loja
                      </Link>
                    }
                  >
                    A loja não abre nesse horário, então este item nunca aparece no cardápio.
                  </WarnNote>
                </div>
              )}
            </div>
          ))}
          <Button variant="outline" className="self-start" onClick={() => onChange({ ...value, ranges: [...value.ranges, newRange()] })}>
            <PlusIcon aria-hidden /> Nova faixa
          </Button>
          <div className="text-xs text-ink-3">Fora da faixa, o item some do cardápio e a IA responde que ele só sai nesses horários.</div>
        </section>
      )}

      <section className={cn(BLOCK, "flex flex-col gap-3 p-5")}>
        <h2 className="font-heading text-title font-semibold">Na semana</h2>
        <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] gap-1 text-center text-xs tabular-nums">
          <span />
          {WEEK_ORDER.map((day) => (
            <span key={day} className="font-medium text-ink-2">
              {WEEKDAY_SHORT[day]}
            </span>
          ))}
          <span className="self-center text-left text-ink-3">Loja</span>
          {WEEK_ORDER.map((day) => {
            const label = store ? storeLabel(store[day]) : "—";
            return (
              <span key={day} className={cn("rounded-sm px-1 py-1.5", label === "Fechado" || !store ? "bg-surface-2 text-ink-3" : "bg-success-lt text-success-ink")}>
                {label}
              </span>
            );
          })}
          <span className="self-center text-left text-ink-3">Item</span>
          {WEEK_ORDER.map((day) => {
            const mine = slots && value.restricted ? slots.filter((slot) => slot.weekday === day) : null;
            const label = mine === null ? "Sempre" : mine.length ? mine.map((slot) => `${clockText(slot.startMinute).replace(":00", "")}–${clockText(slot.endMinute).replace(":00", "")}`).join(" ") : "—";
            return (
              <span key={day} className={cn("rounded-sm px-1 py-1.5", mine !== null && mine.length === 0 ? "bg-surface-2 text-ink-3" : "bg-success-lt text-success-ink")}>
                {label}
              </span>
            );
          })}
        </div>
      </section>
    </div>
  );
}
