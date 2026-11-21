"use client";

import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** Dias de Brasília como "AAAA-MM-DD"; a comparação de texto já ordena. */
export type DayRange = { from: string; to: string };

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const WEEKDAYS = ["D", "S", "T", "Q", "Q", "S", "S"];

const pad = (value: number) => String(value).padStart(2, "0");
const iso = (year: number, month: number, day: number) => `${year}-${pad(month + 1)}-${pad(day)}`;
const short = (day: string) => `${day.slice(8)}/${day.slice(5, 7)}`;

/** O rótulo do botão: "Hoje", um dia ou um período. */
export function rangeLabel(range: DayRange, today: string): string {
  if (range.from === today && range.to === today) return "Hoje";
  if (range.from === range.to) return short(range.from);
  return `${short(range.from)} a ${short(range.to)}`;
}

/**
 * Seletor de um dia ou de um período, com calendário e os atalhos "Este mês" e "Mês passado". Um clique escolhe o dia;
 * um segundo clique fecha o período. Dias depois de hoje ficam desabilitados.
 */
export function DayRangePicker({ value, today, onChange }: { value: DayRange; today: string; onChange: (range: DayRange) => void }) {
  const [open, setOpen] = useState(false);
  const [year, month] = [Number(value.from.slice(0, 4)), Number(value.from.slice(5, 7)) - 1];
  const [view, setView] = useState({ year, month });
  const [start, setStart] = useState<string | null>(null); // primeiro clique de um período, esperando o segundo

  const todayYear = Number(today.slice(0, 4));
  const todayMonth = Number(today.slice(5, 7)) - 1;
  const atLatest = view.year === todayYear && view.month === todayMonth;
  const step = (delta: number) => setView((current) => ({ year: current.year + Math.floor((current.month + delta) / 12), month: (current.month + delta + 12) % 12 }));
  const apply = (range: DayRange) => {
    onChange(range);
    setStart(null);
    setOpen(false);
  };
  const pick = (day: string) => {
    if (!start) return setStart(day);
    apply(day < start ? { from: day, to: start } : { from: start, to: day });
  };

  const shortcut = (monthsBack: number) => {
    const first = new Date(Date.UTC(todayYear, todayMonth - monthsBack, 1));
    const last = monthsBack === 0 ? today : iso(first.getUTCFullYear(), first.getUTCMonth(), new Date(Date.UTC(todayYear, todayMonth, 0)).getUTCDate());
    apply({ from: iso(first.getUTCFullYear(), first.getUTCMonth(), 1), to: last });
  };

  const offset = new Date(Date.UTC(view.year, view.month, 1)).getUTCDay();
  const length = new Date(Date.UTC(view.year, view.month + 1, 0)).getUTCDate();
  const low = start ?? value.from;
  const high = start ?? value.to;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setView({ year, month });
        else setStart(null);
      }}
    >
      <PopoverTrigger className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rule bg-surface px-3 text-[12.5px] font-medium text-ink hover:border-ink-3">
        <CalendarIcon className="size-3.5 text-ink-3" aria-hidden />
        {rangeLabel(value, today)}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[268px] gap-2 p-3">
        <div className="flex gap-1.5">
          <ShortcutButton onClick={() => apply({ from: today, to: today })}>Hoje</ShortcutButton>
          <ShortcutButton onClick={() => shortcut(0)}>Este mês</ShortcutButton>
          <ShortcutButton onClick={() => shortcut(1)}>Mês passado</ShortcutButton>
        </div>
        <div className="flex items-center justify-between">
          <button type="button" onClick={() => step(-1)} aria-label="Mês anterior" className="grid size-7 place-items-center rounded-md hover:bg-surface-2">
            <ChevronLeftIcon className="size-4" aria-hidden />
          </button>
          <span className="text-[13px] font-semibold capitalize">
            {MONTHS[view.month]} de {view.year}
          </span>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={atLatest}
            aria-label="Próximo mês"
            className="grid size-7 place-items-center rounded-md hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ChevronRightIcon className="size-4" aria-hidden />
          </button>
        </div>
        <div className="grid grid-cols-7 gap-y-0.5 text-center text-[12px]">
          {WEEKDAYS.map((weekday, index) => (
            <span key={index} className="py-1 text-[11px] font-medium text-ink-3">
              {weekday}
            </span>
          ))}
          {Array.from({ length: offset }, (_, index) => (
            <span key={`blank-${index}`} />
          ))}
          {Array.from({ length: length }, (_, index) => {
            const day = iso(view.year, view.month, index + 1);
            const edge = day === low || day === high;
            return (
              <button
                key={day}
                type="button"
                disabled={day > today}
                onClick={() => pick(day)}
                aria-pressed={edge}
                className={cn(
                  "h-8 tabular-nums hover:bg-surface-2 disabled:text-ink-3/50 disabled:hover:bg-transparent",
                  day > low && day < high && "bg-surface-2",
                  edge && "rounded-md bg-ink font-semibold text-paper hover:bg-ink",
                  day === today && !edge && "font-semibold text-tomate",
                )}
              >
                {index + 1}
              </button>
            );
          })}
        </div>
        <p className="text-[11.5px] text-ink-3">{start ? "Escolha o último dia do período, ou o mesmo dia." : "Clique em um dia, ou em dois para um período."}</p>
      </PopoverContent>
    </Popover>
  );
}

function ShortcutButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button type="button" onClick={onClick} className="h-7 flex-1 rounded-md border border-rule bg-surface text-[11.5px] font-medium hover:border-ink-3">
      {children}
    </button>
  );
}
