"use client";

import { LoaderCircleIcon, SparklesIcon } from "lucide-react";
import type { ReactNode } from "react";
import { usePendingAction } from "@/hooks/use-pending-action";
import { cn } from "@/lib/utils";

/**
 * Peças das páginas de Configurações. O design só tem board para Integrações: as outras páginas usam o título, os
 * cartões brancos sobre o papel e os rótulos daquele board.
 */

/** Título da página, com a ação principal à direita (quando há). */
export function SettingsHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-heading text-[21px] font-bold tracking-[-0.3px]">{title}</h1>
        <p className="mt-1 text-ink-3">{description}</p>
      </div>
      {children}
    </div>
  );
}

/** Cartão de uma configuração: título e explicação no topo; o conteúdo vem em <CardBody>, <CardFooter> e <CardPreview>. */
export function Card({
  title,
  description,
  aside,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** À direita do título (ex.: a situação). */
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-rule-soft bg-surface">
      <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4">
        <div className="min-w-0">
          <h2 className="font-heading text-title font-semibold">{title}</h2>
          {description && <p className="mt-1 leading-normal text-ink-2">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("border-t border-rule-soft px-6 py-5", className)}>{children}</div>;
}

/** Rodapé do cartão: à esquerda o erro (ou o aviso de quem não pode alterar), à direita os botões. */
export function CardFooter({ error, note, children }: { error?: string | null; note?: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-[58px] items-center justify-between gap-4 border-t border-rule-soft bg-paper/60 px-6 py-3">
      {error ? (
        <p role="alert" className="text-[12px] text-tomate">
          {error}
        </p>
      ) : (
        <p className="text-[12px] text-ink-3">{note}</p>
      )}
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** Rótulo em maiúsculas dos blocos (board Integrações). */
export function Eyebrow({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("text-[10px] font-bold tracking-[0.07em] text-ink-3 uppercase", className)}>{children}</div>;
}

/** Faixa de prévia no pé do cartão: como a mensagem chega ao cliente. */
export function CardPreview({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t border-rule-soft bg-paper px-6 py-5">
      <Eyebrow className="mb-2.5">{label}</Eyebrow>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

/** Balão de automação da conversa (âmbar), com o nome da mensagem. */
export function AutomationBubble({ label, text }: { label: string; text: string }) {
  return (
    <div className="max-w-[440px] rounded-[10px] border border-warning-line bg-warning-lt px-3.5 py-2.5">
      <div className="mb-1 flex items-center gap-[5px] text-[10.5px] font-semibold text-warning-ink">
        <SparklesIcon className="size-3" aria-hidden />
        Automação · {label}
      </div>
      <div className="leading-[1.45] break-words whitespace-pre-wrap">{text}</div>
    </div>
  );
}

/**
 * Liga e desliga que grava na hora: enquanto salva, fica travado (guard de duplo clique) e mostra o carregando.
 * `onChange` devolve a Promise da gravação.
 */
export function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => Promise<void>;
}) {
  const [change, saving] = usePendingAction(onChange);
  return (
    <label className={cn("flex items-start gap-3 px-6 py-4", disabled && "opacity-55")}>
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-ink"
        checked={checked}
        disabled={disabled || saving}
        onChange={(event) => change(event.target.checked)}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">{label}</span>
        <span className="mt-0.5 block text-[12px] leading-normal text-ink-3">{hint}</span>
      </span>
      {saving && (
        <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-3" role="status">
          <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />
          Carregando…
        </span>
      )}
    </label>
  );
}

/** Caixa de texto das mensagens (mesma borda e foco dos inputs). */
export const TEXTAREA =
  "w-full resize-y rounded-lg border border-input bg-surface px-3 py-2 text-[13px] leading-normal outline-none placeholder:text-ink-3 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/8 disabled:opacity-55 aria-invalid:border-destructive";
