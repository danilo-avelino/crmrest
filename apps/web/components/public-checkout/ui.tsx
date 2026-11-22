"use client";

import { ChevronLeftIcon } from "lucide-react";
import Link from "next/link";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Topo das telas do checkout (W8 a W10): voltar, título e o passo à direita ou o indicador de passos embaixo. */
export function CheckoutHeader({
  title,
  onBack,
  backHref,
  right,
  step,
}: {
  title: string;
  onBack?: () => void;
  backHref?: string;
  right?: string;
  /** Passo atual do indicador Entrega, Pagamento e Revisão (sem fidelidade, R9). */
  step?: 1 | 2 | 3;
}) {
  const back = "flex size-11 items-center justify-center rounded-lg text-ink hover:bg-surface-2";
  return (
    <header className="sticky top-0 z-10 border-b border-rule bg-surface">
      <div className="flex h-14 items-center gap-1 px-2">
        {onBack ? (
          <button type="button" aria-label="Voltar" onClick={onBack} className={back}>
            <ChevronLeftIcon className="size-[18px]" aria-hidden />
          </button>
        ) : (
          <Link href={backHref ?? "/"} aria-label="Voltar" className={back}>
            <ChevronLeftIcon className="size-[18px]" aria-hidden />
          </Link>
        )}
        <h1 className="m-0 font-heading text-title font-semibold">{title}</h1>
        {right && <span className="ml-auto pr-2 text-[12px] text-ink-3">{right}</span>}
      </div>
      {step && <Stepper step={step} />}
    </header>
  );
}

const STEPS = ["Entrega", "Pagamento", "Revisão"] as const;

export function Stepper({ step }: { step: 1 | 2 | 3 }) {
  return (
    <ol aria-label="Passos do checkout" className="m-0 flex list-none gap-1.5 px-4 pb-3">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const done = n <= step;
        return (
          <li key={label} className="flex flex-1 flex-col gap-1.5" aria-current={n === step ? "step" : undefined}>
            <span className={cn("h-1 rounded-sm", done ? "bg-ink" : "bg-rule")} />
            <span className={cn("text-[12px]", n === step ? "font-semibold" : done ? "" : "text-ink-3")}>
              {n} {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Rodapé fixo com o botão principal (52 px) e o que vier acima dele (taxa e prazo). */
export function CheckoutFooter({ children, top }: { children: ReactNode; top?: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-10 border-t border-rule bg-surface">
      <div className="mx-auto w-full max-w-xl">
        {top}
        <div className="px-4 pt-2.5 pb-4">{children}</div>
      </div>
    </div>
  );
}

/** Botão na cor do restaurante; `onClick` com Promise já tem o guard de duplo clique e o "Carregando…". */
export function AccentButton({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      size="lg"
      className={cn("h-[52px] w-full rounded-xl bg-(--menu-accent) text-[15px] text-white hover:bg-(--menu-accent) hover:opacity-90", className)}
      {...props}
    />
  );
}

export const inputClass =
  "h-11 w-full min-w-0 rounded-lg border border-rule bg-surface px-3 text-[15px] text-ink outline-none placeholder:text-ink-3 focus:border-ink focus:shadow-[0_0_0_3px_rgba(26,24,20,.08)] aria-invalid:border-tomate";

/** Campo com rótulo, "(opcional)", dica e erro embaixo (R3: cada erro junto do seu campo). */
export function Field({
  id,
  label,
  optional,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  optional?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label} {optional && <span className="font-normal text-ink-3">(opcional)</span>}
      </label>
      {children}
      {hint && !error && (
        <div id={`${id}-hint`} className="text-[12px] text-ink-3">
          {hint}
        </div>
      )}
      {error && (
        <div id={`${id}-error`} className="text-[12px] font-medium text-tomate">
          {error}
        </div>
      )}
    </div>
  );
}

/** Aviso de erro em tomate claro. */
export function ErrorNote({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg bg-tomate-lt p-2.5 text-[#9C2914]">
      <span className="flex-1">
        <span className="block font-semibold">{title}</span>
        {children}
      </span>
    </div>
  );
}

/** Relógio que anda de segundo em segundo (contagem do reenvio). */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** "0:45". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Bolinha do rádio dos cartões (anel grosso quando marcado). */
export function RadioDot({ on }: { on: boolean }) {
  return <span aria-hidden className={cn("size-5 flex-none rounded-full", on ? "border-[6px] border-ink" : "border-2 border-[#C4BDB2]")} />;
}
