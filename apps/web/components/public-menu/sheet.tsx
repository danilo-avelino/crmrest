"use client";

import { type ReactNode, useEffect, useRef } from "react";

/**
 * Camada do cardápio público: folha na base no celular, janela no centro no desktop. Fecha com Esc, com o fundo
 * ou com o botão. `full` ocupa a tela toda (busca). `item` é a ficha do item: tela cheia no celular e janela larga no
 * desktop, sem cabeçalho (o fechar fica sobre a foto). Sem biblioteca: o cardápio abre no navegador do WhatsApp.
 */
export function Sheet({
  title,
  onClose,
  full = false,
  item = false,
  children,
}: {
  title: string;
  onClose: () => void;
  full?: boolean;
  item?: boolean;
  children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center lg:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} aria-hidden="true" />
      <div
        className={
          item
            ? "relative flex h-dvh w-full flex-col overflow-hidden bg-surface lg:h-[min(86dvh,720px)] lg:max-w-4xl lg:rounded-xl"
            : full
            ? "relative flex h-dvh w-full flex-col overflow-hidden bg-paper lg:h-[80dvh] lg:max-w-xl lg:rounded-xl"
            : "relative flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-paper lg:max-w-lg lg:rounded-xl"
        }
      >
        {!full && !item && (
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-rule bg-surface pr-1 pl-4">
            <h2 className="m-0 font-heading text-title font-semibold">{title}</h2>
            <button ref={closeRef} type="button" onClick={onClose} className="flex size-11 items-center justify-center rounded-lg" aria-label="Fechar">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        )}
        {(full || item) && <button ref={closeRef} type="button" className="sr-only" onClick={onClose}>Fechar</button>}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
