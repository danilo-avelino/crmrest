import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PublicMenuStore } from "@/lib/public-menu";
import { StoreInfoButton } from "./store-info";

/** Marca do restaurante: logo se houver, senão as iniciais na cor de destaque. */
export function StoreLogo({ store, size, className }: { store: PublicMenuStore; size: number; className?: string }) {
  const box = { width: size, height: size };
  if (store.logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- logo do restaurante, URL externa.
    return <img src={store.logoUrl} alt="" width={size} height={size} style={box} className={cn("shrink-0 rounded-xl object-cover", className)} />;
  }
  return (
    <div
      style={{ ...box, fontSize: size * 0.36 }}
      className={cn("flex shrink-0 items-center justify-center rounded-xl bg-(--menu-accent) font-heading font-bold text-white", className)}
      aria-hidden="true"
    >
      {initials(store.name)}
    </div>
  );
}

/** Estado em uma linha (formato do Cardápio Web): verde aberto, tomate fechado, âmbar pausado. */
function StatusText({ store }: { store: PublicMenuStore }) {
  if (store.status === "open") return <span className="font-semibold text-success-ink">{store.closesAt ? `Aberto · fecha às ${store.closesAt}` : "Aberto agora"}</span>;
  if (store.status === "paused") return <span className="font-semibold text-warning-ink">Pausado agora, volte em instantes</span>;
  return <span className="font-semibold text-tomate">{store.nextOpening ? `Fechado · Abre ${store.nextOpening}` : "Fechado agora"}</span>;
}

function Cover({ store, className }: { store: PublicMenuStore; className: string }) {
  return store.coverUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- capa do restaurante, URL externa.
    <img src={store.coverUrl} alt="" className={`w-full object-cover ${className}`} />
  ) : (
    <div className={`bg-[#3B2A22] ${className}`} aria-hidden="true" />
  );
}

/**
 * Topo da loja no formato do Cardápio Web. Celular: capa inteira, cartão claro por cima com o logo redondo centralizado,
 * nome, cidade · Mais informações e o estado. Desktop: barra na cor da loja (Início, Promoções, Pedidos, Entrar), capa
 * com cantos arredondados e o logo quadrado sobreposto à esquerda. Renderizado no servidor.
 */
export function StoreHero({ store, slug }: { store: PublicMenuStore; slug: string }) {
  const account = `/c/${encodeURIComponent(slug)}/conta`;
  const nav = "flex h-10 items-center gap-2 rounded-lg px-4 font-semibold text-white/85 hover:bg-white/10";
  return (
    <header>
      <nav aria-label="Navegação da loja" className="hidden bg-(--menu-accent) lg:block">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-around px-8">
          <a href="#topo" className={cn(nav, "bg-white text-(--menu-accent) hover:bg-white")}>Início</a>          <a href={account} className={nav}>Pedidos</a>
          <a href={account} className={nav}>Entrar</a>
        </div>
      </nav>

      <div id="topo" className="lg:mx-auto lg:max-w-6xl lg:px-8 lg:pt-4">
        <Cover store={store} className="h-[180px] lg:h-[300px] lg:rounded-2xl" />

        {/* Celular: cartão por cima da capa, logo redondo centralizado. */}
        <div className="relative -mt-8 flex flex-col items-center gap-1.5 rounded-t-3xl bg-surface px-4 pt-14 pb-4 text-center shadow-[0_-2px_12px_rgba(26,24,20,.06)] lg:hidden">
          <StoreLogo store={store} size={96} className="absolute -top-12 left-1/2 -translate-x-1/2 rounded-full border-4 border-surface" />
          <h1 className="m-0 font-heading text-[22px] leading-tight font-bold">{store.name}</h1>
          <div className="flex flex-wrap items-center justify-center gap-x-2 text-[13px] text-ink-2">
            {store.city && <span>{store.city}</span>}
            {store.city && <span aria-hidden>•</span>}
            <StoreInfoButton store={store} className="font-semibold text-ink" />
          </div>
          <div className="text-[13px]">
            <StatusText store={store} />
          </div>
        </div>

        {/* Desktop: logo quadrado sobreposto, nome grande e a linha de estado · cidade · Mais informações. */}
        <div className="hidden items-end gap-6 px-12 lg:flex">
          <StoreLogo store={store} size={150} className="-mt-20 rounded-2xl border-4 border-surface shadow-md" />
          <div className="flex flex-col gap-1.5 pb-2">
            <h1 className="m-0 font-heading text-[34px] leading-tight font-bold tracking-[-0.5px]">{store.name}</h1>
            <div className="flex flex-wrap items-center gap-x-2.5 text-ink-2">
              <StatusText store={store} />
              {store.city && <span aria-hidden>•</span>}
              {store.city && <span>{store.city}</span>}
              <span aria-hidden>•</span>
              <StoreInfoButton store={store} className="font-semibold text-ink" />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
