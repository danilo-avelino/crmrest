"use client";

import { useEffect, useState } from "react";
import { type PublicMenuCategory, type PublicMenuItem, type PublicMenuStore, priceLabel, showcaseDue, showcaseItems } from "@/lib/public-menu";
import { Sheet } from "./sheet";

/** Abre a vitrine na hora (botão Promoções da barra), sem a regra da frequência. */
export const PROMO_EVENT = "dd:promocoes";

const key = (slug: string) => `dd-showcase:${slug}`;

function lastShown(slug: string): number | null {
  try {
    const raw = localStorage.getItem(key(slug));
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function remember(slug: string, now: number) {
  try {
    localStorage.setItem(key(slug), String(now));
  } catch {
    // Navegador sem armazenamento (aba anônima): a vitrine pode voltar na próxima visita.
  }
}

/**
 * W3: vitrine de promoções ao abrir o cardápio. Folha na base no celular, janela no desktop (Sheet). Aparece no máximo
 * uma vez a cada N horas por navegador e nunca mostra item esgotado ou fora do horário (R4). Tocar num item abre a ficha.
 */
export function PromoShowcase({
  slug,
  store,
  categories,
  onPick,
}: {
  slug: string;
  store: PublicMenuStore;
  categories: PublicMenuCategory[];
  onPick: (item: PublicMenuItem) => void;
}) {
  const items = showcaseItems(categories, store.promoShowcase?.itemIds ?? []);
  const hours = store.promoShowcase?.frequencyHours ?? 24;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const show = () => setOpen(true);
    // Link "Promoções" da barra do desktop: ?promocoes=1.
    if (new URLSearchParams(window.location.search).has("promocoes")) setTimeout(show, 0);
    window.addEventListener(PROMO_EVENT, show);
    return () => window.removeEventListener(PROMO_EVENT, show);
  }, []);

  useEffect(() => {
    if (items.length === 0 || store.status === "paused") return;
    // Um instante depois de abrir: o cardápio aparece primeiro (e o localStorage só existe no navegador).
    const timer = setTimeout(() => {
      const now = Date.now();
      if (!showcaseDue(lastShown(slug), now, hours)) return;
      remember(slug, now);
      setOpen(true);
    }, 600);
    return () => clearTimeout(timer);
    // Só ao abrir a página.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!open || items.length === 0) return null;
  const close = () => setOpen(false);
  return (
    <Sheet title="Promoções" onClose={close}>
      <ul className="flex flex-col gap-2.5">
        {items.map((item) => {
          const price = priceLabel(item);
          return (
            <li key={item.id}>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-xl border border-rule bg-surface p-2.5 text-left hover:border-ink-3"
                onClick={() => {
                  close();
                  onPick(item);
                }}
              >
                {item.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.photoUrl} alt="" className="size-16 shrink-0 rounded-lg object-cover" />
                ) : (
                  <span aria-hidden className="size-16 shrink-0 rounded-lg bg-surface-2" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{item.name}</span>
                  {item.description && <span className="line-clamp-2 block text-[12.5px] text-ink-2">{item.description}</span>}
                  {price && <span className="mt-0.5 block text-[13px] font-medium tabular-nums">{price}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={close} className="mt-4 h-11 w-full rounded-lg border border-rule bg-surface font-medium">
        Ver o cardápio completo
      </button>
    </Sheet>
  );
}
