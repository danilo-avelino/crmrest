"use client";

import { AlertTriangleIcon, StarIcon } from "lucide-react";
import Link from "next/link";
import { Children, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { count, dayTime, score } from "@/lib/format";
import { cn } from "@/lib/utils";

// Peças do board "Avaliações · Atendimento · iFood · Estados": cartões de número, tabelas em grade, selos e estados.

export function plural(value: number, one: string, many: string): string {
  return `${count(value)} ${value === 1 ? one : many}`;
}

/** "Hoje, 20:41", "Ontem, 21:12" ou "21/10, 20:14". */
export function when(iso: string, now: number): string {
  const text = dayTime(iso, now);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Parte de um total, arredondada: "14%". */
export function share(part: number, total: number): string {
  return `${Math.round((part / total) * 100)}%`;
}

/** Título de um bloco grande da aba (Fraunces 22px), com selo opcional e a explicação embaixo. */
export function BlockTitle({ title, badge, note }: { title: string; badge?: string; note: string }) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2.5">
        <h2 className="font-heading text-[22px] font-semibold tracking-[-0.2px]">{title}</h2>
        {badge && (
          <span className="rounded-full border border-tomate-line bg-tomate-lt px-2.5 py-[3px] text-[11px] font-semibold text-tomate">{badge}</span>
        )}
      </div>
      <p className="mt-1 text-[13px] text-ink-3">{note}</p>
    </div>
  );
}

/** Rótulo em caixa alta acima de uma tabela ou cartão. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("mb-2.5 text-[10px] font-bold tracking-[0.09em] text-ink-3 uppercase", className)}>{children}</h3>;
}

const VALUE_TONE = { ink: "text-ink", success: "text-success", danger: "text-tomate" };

export function Metric({
  label,
  value,
  suffix,
  detail,
  tone = "ink",
}: {
  label: string;
  value: string;
  suffix?: string;
  detail: string;
  tone?: keyof typeof VALUE_TONE;
}) {
  return (
    <div className="rounded-2xl border border-rule-soft bg-surface px-5 py-[18px]">
      <div className="text-[12.5px] text-ink-2">{label}</div>
      <div className="mt-2.5 flex items-baseline">
        <span className={cn("font-heading text-[34px] leading-none font-semibold tracking-[-0.5px] tabular-nums", VALUE_TONE[tone])}>{value}</span>
        {suffix && <span className="ml-1 text-[15px] font-medium text-ink-3">{suffix}</span>}
      </div>
      <div className="mt-2 text-xs text-ink-3">{detail}</div>
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-2xl border border-rule-soft bg-surface px-5 py-[18px]", className)}>{children}</div>;
}

/** Tabela em grade: `cols` é o grid-template-columns, igual no cabeçalho e nas linhas. */
export function Table({ cols, head, children, empty }: { cols: string; head: string[]; children: ReactNode; empty?: ReactNode }) {
  const rows = Children.toArray(children);
  return (
    <div role="table" className="overflow-hidden rounded-2xl border border-rule-soft bg-surface" style={{ "--cols": cols } as CSSProperties}>
      <div role="row" className="grid grid-cols-(--cols) gap-4 bg-paper/50 px-[18px] py-[11px]">
        {head.map((title, index) => (
          <div key={index} role="columnheader" className="text-[10.5px] font-bold tracking-[0.07em] text-ink-3 uppercase">
            {title}
          </div>
        ))}
      </div>
      {rows.length === 0 ? <div className="border-t border-rule-soft">{empty}</div> : rows}
    </div>
  );
}

export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="row" className={cn("grid grid-cols-(--cols) items-center gap-4 border-t border-rule-soft px-[18px] py-3 text-[13px]", className)}>
      {Children.map(children, (cell) => (
        <div role="cell" className="min-w-0">
          {cell}
        </div>
      ))}
    </div>
  );
}

const PILL = {
  success: "bg-success-lt text-success",
  warning: "bg-warning-lt text-warning",
  danger: "bg-tomate-lt text-tomate",
  neutral: "bg-surface-2 text-ink-2",
};
export type PillTone = keyof typeof PILL;

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return <span className={cn("inline-block rounded-full px-[9px] py-[3px] text-[11.5px] font-semibold whitespace-nowrap", PILL[tone])}>{children}</span>;
}

/** Nota de 1 a 5 num quadradinho: verde (4 e 5), âmbar (3) ou tomate (1 e 2). */
export function ScoreBadge({ value }: { value: number }) {
  const rounded = Math.round(value);
  const tone = rounded >= 4 ? PILL.success : rounded === 3 ? PILL.warning : PILL.danger;
  return (
    <span className={cn("inline-flex h-6 w-[34px] items-center justify-center rounded-lg text-[12.5px] font-bold tabular-nums", tone)} aria-label={`Nota ${rounded} de 5`}>
      {rounded}
    </span>
  );
}

/** Nota média: o quadradinho arredondado e o valor com uma casa ("4,6"). */
export function AverageScore({ value }: { value: number | null }) {
  if (value === null) return <span className="text-ink-3">—</span>;
  return (
    <span className="inline-flex items-center gap-2 tabular-nums">
      <ScoreBadge value={value} />
      {score(value)}
    </span>
  );
}

export function ConversationLink({ id }: { id: string }) {
  return (
    <Link href={`/inbox?conversa=${id}`} className="text-[12.5px] font-medium whitespace-nowrap text-tomate hover:underline hover:underline-offset-2">
      Ver conversa →
    </Link>
  );
}

/** Filtro em botões: o ativo em ink. */
export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[12.5px] whitespace-nowrap",
        active ? "border-ink bg-ink font-semibold text-surface" : "border-rule-soft bg-surface font-medium text-ink-2 hover:bg-paper",
      )}
    >
      {children}
    </button>
  );
}

/** Barra horizontal com rótulo à esquerda e número à direita (motivos, distribuição das notas). */
export function BarRow({ label, value, max, text, tone = "tomate", labelWidth = "200px" }: {
  label: ReactNode;
  value: number;
  max: number;
  text: string;
  tone?: "tomate" | "ink";
  labelWidth?: string;
}) {
  return (
    <div className="grid items-center gap-3 py-1.5 text-[13px]" style={{ gridTemplateColumns: `${labelWidth} minmax(0,1fr) 70px` }}>
      <div className="min-w-0 truncate">{label}</div>
      <div className="h-2 rounded-sm bg-surface-2">
        <div className={cn("h-2 rounded-sm", tone === "tomate" ? "bg-tomate" : "bg-ink")} style={{ width: `${max ? (value / max) * 100 : 0}%` }} />
      </div>
      <div className="text-right text-ink-2 tabular-nums">{text}</div>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center px-2.5 py-[26px] text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-surface-2">
        <StarIcon className="size-[17px] text-ink-3" strokeWidth={1.5} aria-hidden />
      </div>
      <div className="mt-3.5 text-sm font-semibold">{title}</div>
      {hint && <div className="mt-1 text-[12.5px] text-ink-3">{hint}</div>}
    </div>
  );
}

export function ErrorState({ title, onRetry }: { title: string; onRetry: () => unknown }) {
  return (
    <Card className="mx-auto max-w-md">
      <div className="flex flex-col items-center px-2.5 py-[26px] text-center">
        <div className="flex size-11 items-center justify-center rounded-full bg-tomate-lt">
          <AlertTriangleIcon className="size-[18px] text-tomate" aria-hidden />
        </div>
        <div className="mt-3.5 text-sm font-semibold">{title}</div>
        <div className="mt-1 text-[12.5px] text-ink-3">Verifique a conexão e tente de novo.</div>
        <Button variant="outline" className="mt-4" onClick={() => onRetry()}>
          Tentar novamente
        </Button>
      </div>
    </Card>
  );
}

/** Carregando: o esqueleto dos quatro cartões de número. */
export function LoadingState() {
  return (
    <div className="grid grid-cols-4 gap-3" aria-busy aria-label="Carregando…">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex flex-col gap-2.5 rounded-2xl border border-rule-soft bg-surface p-[18px]">
          <div className="h-2.5 w-3/5 animate-pulse rounded-[5px] bg-surface-2" />
          <div className="h-6 w-2/5 animate-pulse rounded-[5px] bg-surface-2" />
          <div className="h-2.5 w-4/5 animate-pulse rounded-[5px] bg-surface-2" />
        </div>
      ))}
    </div>
  );
}
