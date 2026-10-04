import { cn } from "@/lib/utils";

/** Marca do design: três linhas de comanda, a última em tomate. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <div className={cn("flex size-7 shrink-0 items-center justify-center rounded-md bg-ink", className)}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <rect x="3" y="4" width="10" height="1.5" rx="0.75" className="fill-paper" />
        <rect x="3" y="7.25" width="7" height="1.5" rx="0.75" className="fill-paper" />
        <rect x="3" y="10.5" width="4.5" height="1.5" rx="0.75" className="fill-tomate" />
      </svg>
    </div>
  );
}
