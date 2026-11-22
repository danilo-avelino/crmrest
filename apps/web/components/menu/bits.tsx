"use client";

import { type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Interruptor pequeno do design (30 x 18): categoria ligada, meio a meio. A ação pode ser assíncrona (guard de duplo clique). */
export function Toggle({ on, label, onToggle, disabled }: { on: boolean; label: string; onToggle: () => unknown; disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn("h-[18px] w-[30px] justify-start rounded-[9px] p-0.5 hover:bg-transparent", on ? "justify-end bg-ink hover:bg-ink" : "bg-[#C4BDB2] hover:bg-[#C4BDB2]")}
    >
      <span className="size-3.5 rounded-full bg-white" />
    </Button>
  );
}

/** Pílula "Disponível / Esgotado" (1 clique). O estado vai sempre escrito. */
export function AvailabilityPill({ available, label, onToggle, className }: { available: boolean; label: string; onToggle: () => unknown; className?: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      role="switch"
      aria-checked={available}
      aria-label={label}
      onClick={onToggle}
      className={cn(
        "h-[30px] w-[124px] justify-start gap-2 rounded-full border py-0 pr-2.5 pl-1.5 text-xs font-semibold",
        available ? "border-success-line bg-success-lt text-success-ink hover:bg-success-lt" : "border-rule bg-surface-2 text-ink-2 hover:bg-surface-2",
        className,
      )}
    >
      <span className={cn("size-[18px] rounded-full", available ? "bg-success" : "bg-[#A8A198]")} />
      {available ? "Disponível" : "Esgotado"}
    </Button>
  );
}

export function ErrorNote({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg bg-tomate-lt px-2.5 py-2 text-[12.5px] text-tomate-ink">
      <span className="min-w-0 flex-1 basis-52">{children}</span>
      {action}
    </div>
  );
}

export function WarnNote({ children, action, tone = "warning" }: { children: ReactNode; action?: ReactNode; tone?: "warning" | "error" }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg px-2.5 py-2 text-[12.5px]",
        tone === "warning" ? "bg-warning-lt text-warning-ink" : "bg-tomate-lt text-tomate-ink",
      )}
    >
      <span className="min-w-0 flex-1 basis-52">{children}</span>
      {action}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-xl bg-rule-soft", className)} />;
}

/** Título de página do painel (Fraunces 28) com as ações à direita. */
export function PageHeader({ crumb, title, children }: { crumb?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="mr-auto min-w-0">
        {crumb && <div className="text-xs text-ink-3">{crumb}</div>}
        <h1 className="truncate font-heading text-display font-bold tracking-[-0.5px]">{title}</h1>
      </div>
      {children}
    </div>
  );
}

export const FIELD_LABEL = "text-[13px] font-medium text-ink";
export const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-surface px-2 text-[13px] text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/8";
export const TEXTAREA_CLASS =
  "w-full rounded-lg border border-input bg-surface px-2.5 py-2 text-[13px] leading-normal text-ink outline-none placeholder:text-ink-3 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/8";
export const BLOCK = "rounded-xl border border-rule bg-surface";

/** Mensagem da API ou a padrão, para erros de leitura. */
export function loadError(error: unknown): { forbidden: boolean; text: string } {
  if (error instanceof ApiError && error.status === 403) {
    return { forbidden: true, text: "O Cardápio não está ligado neste restaurante, ou a sua conta não tem acesso a ele." };
  }
  return { forbidden: false, text: error instanceof ApiError ? error.message : "Não foi possível carregar o cardápio." };
}
