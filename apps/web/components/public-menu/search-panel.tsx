"use client";

import { useEffect, useMemo, useState } from "react";
import { track } from "@/lib/attribution";
import {
  badgesOf,
  highlightParts,
  orderable,
  priceLabel,
  type PublicMenuCategory,
  type PublicMenuItem,
  searchMenu,
} from "@/lib/public-menu";
import { cn } from "@/lib/utils";
import { BadgePill, Photo } from "./item-card";

function Marked({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((part, index) =>
        part.hit ? (
          <mark key={index} className="rounded-sm bg-[#FBE7A6] px-px text-ink">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

function CategoryChips({ categories, onGo }: { categories: PublicMenuCategory[]; onGo: (categoryId: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {categories.map((category) => (
        <button key={category.id} type="button" onClick={() => onGo(category.id)} className="h-9 rounded-full border border-rule bg-surface px-3.5 font-medium">
          {category.name}
        </button>
      ))}
    </div>
  );
}

/** Busca em tela cheia (W2): nome e ingrediente, sobre o cardápio já carregado. Sem rede. */
export function SearchPanel({
  slug,
  categories,
  popular,
  onSelect,
  onClose,
  onGoToCategory,
  whatsapp,
}: {
  slug: string;
  /** Link do WhatsApp da loja (wa.me), para o "Pedir pelo WhatsApp" do nada encontrado. */
  whatsapp?: string | null;
  categories: PublicMenuCategory[];
  popular: PublicMenuItem[];
  onSelect: (item: PublicMenuItem) => void;
  onClose: () => void;
  onGoToCategory: (categoryId: string) => void;
}) {
  const [query, setQuery] = useState("");
  // Funil: uma busca conta quando o cliente para de digitar (3 letras ou mais).
  useEffect(() => {
    const term = query.trim();
    if (term.length < 3) return;
    const timer = setTimeout(() => track(slug, "SEARCH"), 1200);
    return () => clearTimeout(timer);
  }, [query, slug]);
  const term = query.trim();
  const hits = useMemo(() => searchMenu(categories, term), [categories, term]);

  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-rule bg-surface px-2 pt-1.5 pb-2.5">
        <button type="button" onClick={onClose} aria-label="Voltar ao cardápio" className="flex size-11 shrink-0 items-center justify-center">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <div className="relative min-w-0 flex-1">
          <label htmlFor="menu-search" className="sr-only">
            Buscar no cardápio
          </label>
          <input
            id="menu-search"
            type="search"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar sabor, ingrediente…"
            className="h-11 w-full rounded-lg border border-ink bg-surface pr-11 pl-3 text-[15px] shadow-[0_0_0_3px_rgba(26,24,20,.08)] outline-none"
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="Limpar busca" className="absolute top-0 right-0 flex size-11 items-center justify-center text-ink-2">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {term === "" ? (
        <div className="flex flex-col gap-5 p-4">
          {popular.length > 0 && (
            <section>
              <h2 className="m-0 mb-1 font-heading text-title font-semibold">Mais pedidos da casa</h2>
              {popular.map((item, index) => (
                <button key={item.id} type="button" onClick={() => onSelect(item)} className="flex min-h-15 w-full items-center gap-3 border-b border-rule text-left">
                  <span className="w-6 font-heading text-title font-bold text-ink-3">{index + 1}</span>
                  <span className="flex-1 font-medium">{item.name}</span>
                  <span className="text-ink-2 tabular-nums">{priceLabel(item)}</span>
                </button>
              ))}
            </section>
          )}
          <CategoryChips categories={categories} onGo={onGoToCategory} />
        </div>
      ) : hits.length > 0 ? (
        <div className="flex flex-col px-4 pt-3">
          <div className="pb-1 text-[12px] text-ink-2" aria-live="polite">
            {hits.length === 1 ? "1 resultado" : `${hits.length} resultados`} para “{term}”
          </div>
          {hits.map(({ item, categoryName, matchedIn }) => (
            <button
              key={item.id}
              type="button"
              disabled={!orderable(item)}
              onClick={() => onSelect(item)}
              className={cn("flex gap-3 border-b border-rule py-3.5 text-left", !orderable(item) && "cursor-not-allowed opacity-50")}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-[11px] font-semibold tracking-[.04em] text-ink-3 uppercase">
                  {categoryName}
                  {matchedIn === "ingredient" ? " · tem no ingrediente" : ""}
                </span>
                <span className="text-[14px] font-semibold">
                  <Marked text={item.name} query={term} />
                </span>
                {item.description && <span className="line-clamp-2 text-ink-2">{item.description}</span>}
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-semibold tabular-nums">{priceLabel(item)}</span>
                  {badgesOf(item).map((badge) => (
                    <BadgePill key={badge.label} badge={badge} />
                  ))}
                </span>
              </span>
              <Photo url={item.photoUrl} size={80} />
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-4 px-4 py-8">
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-tag-line bg-surface px-5 py-6 text-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="text-ink-3" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5M8.5 11h5" />
            </svg>
            <div className="font-heading text-title font-semibold">Nada encontrado para “{term}”</div>
            <div className="text-ink-2">Confira a escrita ou veja as categorias do cardápio.</div>
          </div>
          <CategoryChips categories={categories} onGo={onGoToCategory} />
          <button type="button" onClick={onClose} className="h-12 rounded-lg bg-ink font-medium text-paper">
            Ver cardápio completo
          </button>
          {whatsapp && (
            <a
              href={`${whatsapp}?${new URLSearchParams({ text: `Olá! Procurei "${term}" no cardápio e não encontrei. Vocês têm?` })}`}
              target="_blank"
              rel="noreferrer"
              className="flex h-12 items-center justify-center rounded-lg border border-rule bg-surface font-medium text-ink no-underline"
            >
              Pedir pelo WhatsApp
            </a>
          )}
        </div>
      )}
    </div>
  );
}
