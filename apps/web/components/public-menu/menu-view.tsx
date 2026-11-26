"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { track } from "@/lib/attribution";
import { CartProvider } from "@/lib/public-cart";
import { NoticesStrip } from "@/components/public-menu/notices-strip";
import { highlightsOf, priceLabel, type PublicMenu, type PublicMenuItem, visibleCategories } from "@/lib/public-menu";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import { Bag } from "./bag";
import { BottomNav } from "./bottom-nav";
import { DeliveryCard } from "./delivery-card";
import { LoginBenefitsCard } from "./login-benefits-card";
import { ItemCard } from "./item-card";
import { ItemSheet } from "./item-sheet";
import { ConsentBanner, MetaPixel } from "./ads-consent";
import { PromoShowcase } from "./promo-showcase";
import { storeContactLink } from "@/lib/public-checkout";
import { ContextFromChat } from "./context-from-chat";
import { ReorderFromOrder } from "./reorder-from-order";
import { ReorderStrip } from "./reorder-strip";
import { SearchPanel } from "./search-panel";
import { Sheet } from "./sheet";
import { StoreLogo } from "./store-hero";

const HIGHLIGHTS_ID = "destaques";
const categoryDomId = (id: string) => `cat-${id}`;

const SearchIcon = ({ className }: { className?: string }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </svg>
);

/**
 * Lista do cardápio no formato do Cardápio Web: barra fixa com a lista de categorias e a busca, destaques em cartões e
 * categorias em cartões (2 colunas no desktop), na ordem da API (R5).
 * É a única parte com JavaScript da página; o topo da loja e o rodapé vêm do servidor.
 */
export function MenuView({ slug, menu }: { slug: string; menu: PublicMenu }) {
  const categories = useMemo(() => visibleCategories(menu.categories), [menu.categories]);
  const highlights = useMemo(() => highlightsOf(categories), [categories]);
  const popular = useMemo(() => (highlights.length > 0 ? highlights : categories.flatMap((c) => c.items)).slice(0, 4), [highlights, categories]);

  const [searching, setSearching] = useState(false);
  const [pickingCategory, setPickingCategory] = useState(false);
  const [selected, setSelected] = useState<PublicMenuItem | null>(null);
  const [stuck, setStuck] = useState(false);
  const [active, setActive] = useState<string>(highlights.length > 0 ? HIGHLIGHTS_ID : (categories[0]?.id ?? ""));
  const sentinelRef = useRef<HTMLDivElement>(null);

  // P2: "Abrir ficha" do painel abre o cardápio com `?item=<id>` e a ficha do item já aberta.
  useEffect(() => {
    const url = new URL(window.location.href);
    const itemId = url.searchParams.get("item");
    if (!itemId) return;
    url.searchParams.delete("item");
    window.history.replaceState(null, "", url.toString());
    const found = categories.flatMap((c) => c.items).find((item) => item.id === itemId);
    if (found) queueMicrotask(() => setSelected(found));
    // Só ao abrir a página.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Linha da marca no cabeçalho só depois que o topo da loja saiu da tela.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry!.isIntersecting));
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // Aba da categoria que está na altura do cabeçalho.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const sections = [...document.querySelectorAll<HTMLElement>("[data-menu-section]")];
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setActive(entry.target.getAttribute("data-menu-section")!);
      },
      { rootMargin: "-130px 0px -65% 0px" },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [categories, highlights.length]);

  const goTo = useCallback((domId: string) => {
    setSearching(false);
    requestAnimationFrame(() => document.getElementById(domId)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);
  const closeSearch = useCallback(() => setSearching(false), []);
  const closeItem = useCallback(() => setSelected(null), []);

  // Funil (F7-01/F7-02): a visita ao abrir e cada ficha aberta, com a origem da 1ª visita.
  useEffect(() => {
    track(slug, "PAGE_VIEW");
  }, [slug]);
  const viewedId = selected?.id;
  useEffect(() => {
    if (viewedId) track(slug, "VIEW_CONTENT", { itemId: viewedId });
  }, [slug, viewedId]);
  // Da busca: fecha a busca e abre a ficha do item.
  const pick = useCallback((item: PublicMenuItem) => {
    setSearching(false);
    setSelected(item);
  }, []);

  if (categories.length === 0) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-8 lg:px-8">
        <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-tag-line bg-surface px-5 py-7 text-center">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="text-ink-3" aria-hidden="true">
            <path d="M5 4h14v16H5zM9 8h6M9 12h6M9 16h3" />
          </svg>
          <div className="font-heading text-title font-semibold">O cardápio está sendo montado</div>
          <div className="text-ink-2">Volte daqui a pouco para fazer seu pedido.</div>
        </div>
      </div>
    );
  }

  const sections = [...(highlights.length > 0 ? [{ id: HIGHLIGHTS_ID, label: "Destaques", dom: HIGHLIGHTS_ID }] : []), ...categories.map((c) => ({ id: c.id, label: c.name, dom: categoryDomId(c.id) }))];
  const activeLabel = sections.find((section) => section.id === active)?.label ?? "Lista de categorias";
  const hasPromos = (menu.store.promoShowcase?.itemIds.length ?? 0) > 0;

  return (
    <CartProvider slug={slug}>
      <div className="mx-auto mt-3 flex w-full max-w-6xl flex-col gap-3 px-4 lg:hidden">
        <LoginBenefitsCard slug={slug} />
        <DeliveryCard slug={slug} store={menu.store} />
      </div>
      <div ref={sentinelRef} aria-hidden="true" className="h-px" />
      {/* Barra fixa (formato do Cardápio Web): logo depois que o topo sai da tela, lista de categorias e busca. */}
      <div className={cn("sticky top-0 z-30 bg-paper/95 backdrop-blur", stuck && "border-b border-rule shadow-[0_2px_10px_rgba(26,24,20,.06)]")}>
        <div className="mx-auto flex w-full max-w-6xl items-center gap-2.5 px-4 py-2.5 lg:px-8">
          {stuck && <StoreLogo store={menu.store} size={40} className="rounded-lg" />}
          <button
            type="button"
            onClick={() => setPickingCategory(true)}
            className="flex h-11 max-w-[60%] min-w-0 items-center gap-2 rounded-lg border border-rule bg-surface px-3.5 font-semibold text-ink-2 shadow-[0_1px_2px_rgba(26,24,20,.04)]"
          >
            <span className="truncate">{stuck ? activeLabel : "Lista de categorias"}</span>
            <ChevronDownIcon className="size-4 shrink-0" aria-hidden />
          </button>
          <button type="button" onClick={() => setSearching(true)} aria-label="Buscar no cardápio" className="ml-auto flex size-11 shrink-0 items-center justify-center rounded-lg border border-rule bg-surface lg:hidden">
            <SearchIcon />
          </button>
          <button
            type="button"
            onClick={() => setSearching(true)}
            className="ml-auto hidden h-11 w-80 items-center gap-2.5 rounded-lg border border-rule bg-surface px-3.5 text-left text-ink-3 lg:mr-[352px] lg:flex"
          >
            <SearchIcon className="size-4" />
            Busque por um produto
          </button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-6xl px-4 pb-40 lg:flex lg:items-start lg:gap-8 lg:px-8 lg:pb-16">
        <div className="min-w-0 flex-1">
          <ReorderStrip slug={slug} />
          {(menu.notices?.length ?? 0) > 0 && <NoticesStrip notices={menu.notices!} />}
          {highlights.length > 0 && (
            <section id={HIGHLIGHTS_ID} data-menu-section={HIGHLIGHTS_ID} className="scroll-mt-20 pt-4">
              <h2 className="m-0 mb-3 font-heading text-[22px] font-bold">Destaques</h2>
              <div className="-mr-4 flex gap-3 overflow-x-auto pr-4 pb-1 [scrollbar-width:none] lg:mr-0 lg:grid lg:grid-cols-3 lg:gap-4 lg:overflow-visible lg:pr-0 [&::-webkit-scrollbar]:hidden">
                {highlights.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelected(item)}
                    className="flex w-[176px] shrink-0 flex-col overflow-hidden rounded-xl border border-rule bg-surface text-left shadow-[0_1px_2px_rgba(26,24,20,.04)] hover:border-ink-3 lg:w-auto"
                  >
                    <span className="block h-32 w-full bg-[#E9E3D9] lg:h-44">
                      {item.photoUrl && (
                        // eslint-disable-next-line @next/next/no-img-element -- ver ItemCard.
                        <img src={item.photoUrl} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
                      )}
                    </span>
                    <span className="flex flex-1 flex-col gap-1 p-3">
                      <span className="text-[15px] leading-snug font-semibold">{item.name}</span>
                      {item.description && <span className="line-clamp-2 text-[13px] text-ink-2">{item.description}</span>}
                      <span className="mt-auto pt-2 text-[14px] font-medium tabular-nums">{priceLabel(item)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {categories.map((category) => (
            <section key={category.id} id={categoryDomId(category.id)} data-menu-section={category.id} className="scroll-mt-20 pt-7">
              <h2 className="m-0 font-heading text-[22px] font-bold">{category.name}</h2>
              {category.description && <p className="m-0 mt-1.5 text-ink-2">{category.description}</p>}
              <div className="mt-3 flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:gap-4">
                {category.items.map((item) => (
                  <ItemCard key={item.id} item={item} onSelect={setSelected} />
                ))}
              </div>
            </section>
          ))}
        </div>
        <Bag slug={slug} store={menu.store} categories={categories} top={
            <>
              <LoginBenefitsCard slug={slug} />
              <DeliveryCard slug={slug} store={menu.store} />
            </>
          } />
      </div>

      {pickingCategory && (
        <Sheet title="Categorias" onClose={() => setPickingCategory(false)}>
          <ul className="m-0 flex list-none flex-col p-2">
            {sections.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  onClick={() => {
                    setPickingCategory(false);
                    setActive(section.id);
                    goTo(section.dom);
                  }}
                  className={cn("flex h-12 w-full items-center rounded-lg px-3 text-left font-medium hover:bg-surface-2", active === section.id && "font-semibold text-(--menu-accent)")}
                >
                  {section.label}
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
      <BottomNav slug={slug} hasPromos={hasPromos} />
      {searching && (
        <Sheet title="Buscar no cardápio" full onClose={closeSearch}>
          <SearchPanel
            slug={slug}
            categories={categories}
            popular={popular}
            onSelect={pick}
            onClose={closeSearch}
            onGoToCategory={(id) => goTo(categoryDomId(id))}
            whatsapp={storeContactLink(menu.store.phone)}
          />
        </Sheet>
      )}
      {selected && <ItemSheet slug={slug} item={selected} category={categories.find((c) => c.id === selected.categoryId)} onClose={closeItem} />}
      <PromoShowcase slug={slug} store={menu.store} categories={categories} onPick={setSelected} />
      <ReorderFromOrder slug={slug} categories={categories} />
      <ContextFromChat slug={slug} categories={categories} />
      <MetaPixel pixelId={menu.store.metaPixelId} />
      <ConsentBanner pixelId={menu.store.metaPixelId} />
    </CartProvider>
  );
}
