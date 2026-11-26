import type { ReactNode } from "react";
import { type Badge, badgesOf, money, orderable, priceLabel, type PublicMenuItem } from "@/lib/public-menu";
import { cn } from "@/lib/utils";

const TONES: Record<Badge["tone"], string> = {
  hot: "bg-tomate-lt text-tomate-ink",
  new: "bg-[#E8EEF8] text-[#2B3A67]",
  veg: "bg-success-lt text-success-ink",
  spicy: "bg-warning-lt text-warning-ink",
  muted: "bg-[#E4DFD7] text-ink-2",
};

export function BadgePill({ badge }: { badge: Badge }) {
  return <span className={cn("rounded-md px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.04em] uppercase", TONES[badge.tone])}>{badge.label}</span>;
}

/** Foto do item: <img> simples, preguiçosa e com tamanho fixo (sem salto de layout no navegador do WhatsApp). */
export function Photo({ url, size, className }: { url: string | null; size: number; className?: string }) {
  if (!url) return null;
  // eslint-disable-next-line @next/next/no-img-element -- fotos vêm de URL do restaurante; sem otimizador no domínio.
  return <img src={url} alt="" width={size} height={size} loading="lazy" decoding="async" className={cn("shrink-0 rounded-xl object-cover", className)} style={{ width: size, height: size }} />;
}

/** Faixa diagonal "Esgotado" no canto da foto (formato do Cardápio Web): o item fica no lugar, esmaecido. */
export function SoldOutRibbon() {
  return (
    <span aria-hidden className="pointer-events-none absolute -top-px -right-px size-20 overflow-hidden rounded-tr-lg">
      <span className="absolute top-[18px] -right-[30px] w-[120px] rotate-45 bg-(--menu-accent) py-0.5 text-center text-[11px] font-semibold text-white">Esgotado</span>
    </span>
  );
}

/**
 * Card do item (formato do Cardápio Web): selos em cima, nome, descrição de 3 linhas e preço embaixo, com a foto
 * quadrada à direita. Esgotado ou fora do horário fica esmaecido, no lugar. O clique abre a ficha (F3-04).
 */
export function ItemCard({ item, onSelect, children }: { item: PublicMenuItem; onSelect: (item: PublicMenuItem) => void; children?: ReactNode }) {
  const can = orderable(item);
  const price = priceLabel(item);
  // Com foto, o esgotado vira a faixa na foto; sem foto, fica o selo.
  const badges = badgesOf(item).filter((badge) => !(badge.label === "Esgotado" && item.photoUrl));
  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      disabled={!can}
      className={cn(
        "flex w-full gap-3 rounded-xl border border-rule bg-surface p-4 text-left shadow-[0_1px_2px_rgba(26,24,20,.04)] transition-colors hover:border-ink-3",
        !can && "cursor-not-allowed hover:border-rule",
      )}
    >
      <span className={cn("flex min-h-[112px] min-w-0 flex-1 flex-col gap-1.5", !can && "opacity-50")}>
        {children}
        {badges.length > 0 && (
          <span className="flex flex-wrap gap-1.5">
            {badges.map((badge) => (
              <BadgePill key={badge.label} badge={badge} />
            ))}
          </span>
        )}
        <span className="text-[15px] leading-snug font-semibold">{item.name}</span>
        {item.description && <span className="line-clamp-3 text-[13px] leading-relaxed text-ink-2">{item.description}</span>}
        {price && (
          <span className="mt-auto flex items-baseline gap-2 pt-1 text-[14px] font-medium tabular-nums">
            {price}
            {item.regularPriceCents != null && <s className="text-[12.5px] font-normal text-ink-3">{money(item.regularPriceCents)}</s>}
          </span>
        )}
      </span>
      {item.photoUrl && (
        <span className="relative shrink-0 self-start">
          <Photo url={item.photoUrl} size={112} className={cn("rounded-lg lg:size-32", item.soldOut && "opacity-50 grayscale")} />
          {item.soldOut && <SoldOutRibbon />}
        </span>
      )}
    </button>
  );
}
