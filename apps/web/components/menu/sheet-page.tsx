"use client";

import { ImageIcon, PauseIcon, PlusIcon, StarIcon, CheckIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { BLOCK, ErrorNote, FilterChip, Headline, loadError, MenuPage, PageHeader, SELECT_CLASS } from "@/components/menu/bits";
import { useMenu, useMenuActions } from "@/components/menu/use-menu";
import { Button, buttonVariants } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { centsText, type MenuCategory, type MenuItem, money, parseCents, priceLabel } from "@/lib/menu";
import { plural } from "@/lib/menu-backstage";
import { cn } from "@/lib/utils";

type Status = "AVAILABLE" | "SOLD_OUT" | "PAUSED";
const STATUS_LABEL: Record<Status, string> = { AVAILABLE: "Disponível", SOLD_OUT: "Esgotado", PAUSED: "Pausado" };
const STATUS_STYLE: Record<Status, string> = {
  AVAILABLE: "border-success-line bg-success-lt text-success-ink",
  SOLD_OUT: "border-rule bg-surface-2 text-ink-2",
  PAUSED: "border-warning-line bg-warning-lt text-warning-ink",
};
const FEATURED = "destaque";

type Row = MenuItem & { categoryName: string };
/** Rascunho de uma linha: o que mudou, ainda sem salvar. Preços em texto, como digitados. */
type Draft = { status?: Status; price?: string; promo?: string; cost?: string; featured?: boolean; categoryId?: string };
type Gap = "noPhoto" | "noDescription" | "noCost";

const statusOf = (item: MenuItem): Status => (!item.active ? "PAUSED" : item.soldOut ? "SOLD_OUT" : "AVAILABLE");
const featuredOf = (item: MenuItem) => item.tags.some((t) => t.trim().toLowerCase() === FEATURED);
const hasSizes = (item: MenuItem) => item.sizes.length > 0;

/** N2: preço, custo, status e destaque de vários itens de uma vez, salvos juntos (tudo ou nada). */
export function SheetPage() {
  const menu = useMenu();
  const { call, error } = useMenuActions();
  const toast = useToast();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<Status | "">("");
  const [gap, setGap] = useState<Gap | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const changes = Object.keys(drafts).length;

  // Sair da página descarta as alterações: o navegador avisa antes.
  useEffect(() => {
    if (!changes) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changes]);

  const rows: Row[] = useMemo(
    () => (menu.data?.categories ?? []).flatMap((c: MenuCategory) => c.items.map((item) => ({ ...(item as Row), categoryName: c.name }))),
    [menu.data],
  );

  async function save() {
    setProblem(null);
    const items = [];
    for (const [id, draft] of Object.entries(drafts)) {
      const row = rows.find((r) => r.id === id)!;
      const money = (label: string, text: string | undefined, nullable: boolean) => {
        if (text === undefined) return undefined;
        if (!text.trim()) return nullable ? null : `${row.name}: informe o ${label}.`;
        const cents = parseCents(text);
        return cents === null ? `${row.name}: ${label} inválido.` : cents;
      };
      const priceCents = money("preço", draft.price, false);
      const promoPriceCents = money("preço promocional", draft.promo, true);
      const costCents = money("custo", draft.cost, true);
      for (const v of [priceCents, promoPriceCents, costCents]) if (typeof v === "string") return setProblem(v);
      items.push({ id, status: draft.status, priceCents: priceCents as number | undefined, promoPriceCents: promoPriceCents as number | null | undefined, costCents: costCents as number | null | undefined, featured: draft.featured, categoryId: draft.categoryId });
    }
    if (await call("/items", "PATCH", { items })) {
      toast(`${plural(items.length, "item salvo", "itens salvos")}.`);
      setDrafts({});
      setSelected(new Set());
    }
  }

  const header = (
    <PageHeader title="Edição em planilha" description="Mude preço, custo, status e destaque de vários itens sem abrir um por um.">
      <Button variant="outline" disabled={!changes} onClick={() => setDrafts({})}>
        Descartar
      </Button>
      <Button disabled={!changes} onClick={() => save()}>
        Salvar alterações{changes ? ` (${changes})` : ""}
      </Button>
    </PageHeader>
  );

  if (menu.isPending) {
    return (
      <MenuPage>
        {header}
        <div className={cn(BLOCK, "p-8 text-center text-ink-3")} aria-busy>
          Carregando o catálogo…
        </div>
      </MenuPage>
    );
  }
  if (menu.isError) {
    const failure = loadError(menu.error);
    return (
      <MenuPage>
        {header}
        <ErrorNote action={!failure.forbidden && <Button size="sm" variant="outline" onClick={() => menu.refetch()}>Tentar de novo</Button>}>
          {failure.forbidden ? failure.text : "Não foi possível carregar o catálogo. A planilha precisa da lista completa para não sobrescrever nada. Tente de novo."}
        </ErrorNote>
      </MenuPage>
    );
  }
  if (!rows.length) {
    return (
      <MenuPage>
        {header}
        <section className={cn(BLOCK, "flex flex-col items-center gap-3 px-6 py-12 text-center")}>
          <p className="font-heading text-[22px] font-bold">Nenhum item para editar · 0 itens</p>
          <p className="text-ink-2">A planilha mostra os itens do catálogo. Cadastre ou importe os itens primeiro.</p>
          <div className="flex gap-2">
            <Link href="/cardapio/item/novo" className={buttonVariants()}>
              <PlusIcon aria-hidden /> Novo item
            </Link>
            <Link href="/cardapio/importar" className={buttonVariants({ variant: "outline" })}>
              Importar
            </Link>
          </div>
        </section>
      </MenuPage>
    );
  }

  const categories = menu.data.categories;
  const value = <K extends keyof Draft>(row: Row, key: K): Draft[K] | undefined => drafts[row.id]?.[key];
  const statusNow = (row: Row) => value(row, "status") ?? statusOf(row);
  const costNow = (row: Row) => value(row, "cost") ?? centsText(row.costCents);
  const gaps = { noPhoto: rows.filter((r) => !r.photoUrl).length, noDescription: rows.filter((r) => !r.description?.trim()).length, noCost: rows.filter((r) => r.costCents == null).length };
  const shown = rows.filter(
    (r) =>
      (!categoryFilter || (value(r, "categoryId") ?? r.categoryId) === categoryFilter) &&
      (!statusFilter || statusNow(r) === statusFilter) &&
      (gap !== "noPhoto" || !r.photoUrl) &&
      (gap !== "noDescription" || !r.description?.trim()) &&
      (gap !== "noCost" || r.costCents == null),
  );
  const filterText = categoryFilter ? `categoria ${categories.find((c) => c.id === categoryFilter)?.name}` : "todas as categorias";

  /** Muda um campo; voltar ao valor salvo tira a linha das alterações. */
  function edit(row: Row, patch: Draft) {
    setDrafts((current) => {
      const next: Draft = { ...current[row.id], ...patch };
      const saved: Draft = { status: statusOf(row), price: centsText(row.priceCents), promo: centsText(row.promoPriceCents), cost: centsText(row.costCents), featured: featuredOf(row), categoryId: row.categoryId };
      for (const key of Object.keys(next) as (keyof Draft)[]) if (next[key] === saved[key]) delete next[key];
      const copy = { ...current };
      if (Object.keys(next).length) copy[row.id] = next;
      else delete copy[row.id];
      return copy;
    });
  }


  const allShownSelected = shown.length > 0 && shown.every((r) => selected.has(r.id));
  return (
    <MenuPage>
      {header}
      <Headline
        value={plural(rows.length, "item", "itens")}
        accent={changes ? plural(changes, "alteração não salva", "alterações não salvas") : undefined}
        accentTone="warning"
        sub={`Mostrando ${shown.length} de ${rows.length} · filtro: ${filterText}`}
      >
        <div className="flex w-full flex-wrap items-center gap-1.5">
          <select aria-label="Categoria" className={cn(SELECT_CLASS, "h-8 w-auto")} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">Todas as categorias</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select aria-label="Status" className={cn(SELECT_CLASS, "h-8 w-auto")} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as Status | "")}>
            <option value="">Todos os status</option>
            {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <FilterChip active={gap === "noPhoto"} onClick={() => setGap(gap === "noPhoto" ? null : "noPhoto")}>
            Sem foto {gaps.noPhoto}
          </FilterChip>
          <FilterChip active={gap === "noDescription"} onClick={() => setGap(gap === "noDescription" ? null : "noDescription")}>
            Sem descrição {gaps.noDescription}
          </FilterChip>
          <FilterChip active={gap === "noCost"} onClick={() => setGap(gap === "noCost" ? null : "noCost")}>
            Sem custo {gaps.noCost}
          </FilterChip>
        </div>
      </Headline>

      {selected.size > 0 && <SelectionBar rows={rows.filter((r) => selected.has(r.id))} categories={categories} onEdit={edit} onClear={() => setSelected(new Set())} drafts={drafts} />}
      {(problem || error) && <ErrorNote>{problem ?? error}</ErrorNote>}

      <div className={cn(BLOCK, "overflow-x-auto")}>
        <table className="w-full min-w-[960px] text-left text-[13px]">
          <thead className="border-b border-rule text-[12px] text-ink-3">
            <tr>
              <th className="w-10 py-2.5 pl-3">
                <input
                  type="checkbox"
                  aria-label="Selecionar todos os itens mostrados"
                  className="size-4 accent-ink"
                  checked={allShownSelected}
                  onChange={() => setSelected(allShownSelected ? new Set() : new Set(shown.map((r) => r.id)))}
                />
              </th>
              <th className="w-14 font-medium">Foto</th>
              <th className="font-medium">Item</th>
              <th className="font-medium">Categoria</th>
              <th className="w-40 font-medium">Status</th>
              <th className="w-32 text-right font-medium">Preço</th>
              <th className="w-36 text-center font-medium">Preço promocional</th>
              <th className="w-28 text-right font-medium">Custo</th>
              <th className="w-20 pr-3 text-center font-medium">Destaque</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const draft = drafts[row.id];
              const status = statusNow(row);
              const featured = draft?.featured ?? featuredOf(row);
              const changedCell = "bg-warning-lt";
              return (
                <tr key={row.id} className={cn("border-b border-rule-soft last:border-0", selected.has(row.id) && "bg-surface-2", draft && "border-l-[3px] border-l-warning")}>
                  <td className="py-2 pl-3">
                    <input
                      type="checkbox"
                      aria-label={`Selecionar ${row.name}`}
                      className="size-4 accent-ink"
                      checked={selected.has(row.id)}
                      onChange={() =>
                        setSelected((s) => {
                          const next = new Set(s);
                          if (next.has(row.id)) next.delete(row.id);
                          else next.add(row.id);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td>
                    <div className={cn("flex size-9 items-center justify-center overflow-hidden rounded-md bg-surface-2", !row.photoUrl && "border border-dashed border-rule")}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- foto do restaurante vinda do armazenamento */}
                      {row.photoUrl ? <img src={row.photoUrl} alt="" className="size-full object-cover" /> : <ImageIcon className="size-3.5 text-ink-3" aria-label="Sem foto" />}
                    </div>
                  </td>
                  <td>
                    <Link href={`/cardapio/item/${row.id}`} className="font-semibold hover:underline">
                      {row.name}
                    </Link>
                    <div className="text-[12px] text-ink-3">{row.costCents == null && !draft?.cost ? <span className="text-warning-ink">sem custo</span> : hasSizes(row) ? priceLabel(row) : null}</div>
                  </td>
                  <td className={cn(draft?.categoryId && changedCell)}>{categories.find((c) => c.id === (draft?.categoryId ?? row.categoryId))?.name}</td>
                  <td className={cn(draft?.status && changedCell)}>
                    <select aria-label={`Status de ${row.name}`} className={cn("h-8 w-36 rounded-md border px-2 font-semibold", STATUS_STYLE[status])} value={status} onChange={(e) => edit(row, { status: e.target.value as Status })}>
                      {(Object.keys(STATUS_LABEL) as Status[]).map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className={cn("text-right", draft?.price !== undefined && changedCell)}>
                    {hasSizes(row) ? (
                      <Link href={`/cardapio/item/${row.id}`} className="underline">
                        {plural(row.sizes.length, "tamanho", "tamanhos")}
                      </Link>
                    ) : (
                      <MoneyCell label={`Preço de ${row.name}`} value={draft?.price ?? centsText(row.priceCents)} before={draft?.price !== undefined ? row.priceCents : undefined} onChange={(v) => edit(row, { price: v })} />
                    )}
                  </td>
                  <td className={cn("text-center", draft?.promo !== undefined && changedCell)}>
                    {hasSizes(row) ? (
                      <span className="text-ink-3">—</span>
                    ) : (
                      <MoneyCell
                        label={`Preço promocional de ${row.name}`}
                        placeholder="—"
                        value={draft?.promo ?? centsText(row.promoPriceCents)}
                        before={draft?.promo !== undefined ? (row.promoPriceCents ?? null) : undefined}
                        onChange={(v) => edit(row, { promo: v })}
                      />
                    )}
                  </td>
                  <td className={cn("text-right", draft?.cost !== undefined && changedCell)}>
                    <MoneyCell label={`Custo de ${row.name}`} placeholder="sem custo" value={costNow(row)} before={draft?.cost !== undefined ? (row.costCents ?? null) : undefined} onChange={(v) => edit(row, { cost: v })} />
                  </td>
                  <td className={cn("pr-3 text-center", draft?.featured !== undefined && changedCell)}>
                    <button type="button" aria-pressed={featured} aria-label={`Destaque: ${row.name}`} onClick={() => edit(row, { featured: !featured })} className="rounded p-1 hover:bg-surface-2">
                      <StarIcon className={cn("size-4", featured ? "fill-tomate text-tomate" : "text-ink-3")} aria-hidden />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm border border-warning bg-warning-lt" aria-hidden /> Célula alterada, ainda não salva · o valor anterior fica embaixo
        </span>
        {changes > 0 && <span>Sair da página descarta {changes === 1 ? "a alteração" : `as ${changes} alterações`}.</span>}
        <span className="ml-auto">Item com mais de um tamanho: o preço muda na edição do item.</span>
      </div>
    </MenuPage>
  );
}

/** Célula de dinheiro editável; `before` (centavos, null = vazio) aparece embaixo quando mudou. */
function MoneyCell({ label, value, before, placeholder, onChange }: { label: string; value: string; before?: number | null; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <div className="inline-flex flex-col items-end">
      <span className="relative inline-flex items-center">
        {value.trim() && <span className="pointer-events-none absolute left-2 text-ink-3">R$</span>}
        <input
        aria-label={label}
        inputMode="decimal"
        placeholder={placeholder ?? "0,00"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-28 rounded-md border border-transparent bg-transparent px-2 text-right tabular-nums outline-none placeholder:text-ink-3 hover:border-rule focus:border-ink focus:bg-surface"
        />
      </span>
      {before !== undefined && <span className="pr-2 text-[11px] text-ink-3">antes {before == null ? "vazio" : money(before)}</span>}
    </div>
  );
}

/** Barra escura das ações em massa: mexem no rascunho; nada é salvo antes de "Salvar alterações". */
function SelectionBar({ rows, categories, drafts, onEdit, onClear }: { rows: Row[]; categories: MenuCategory[]; drafts: Record<string, Draft>; onEdit: (row: Row, patch: Draft) => void; onClear: () => void }) {
  const [percent, setPercent] = useState("10");
  const [category, setCategory] = useState("");
  const pct = Number(percent.replace(",", "."));
  const adjustable = rows.filter((r) => !hasSizes(r));
  const sample = adjustable[0];
  const sampleNow = sample ? (parseCents(drafts[sample.id]?.price ?? "") ?? sample.priceCents) : null;
  const adjust = (cents: number) => Math.max(0, Math.round(cents * (1 + pct / 100)));
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-ink px-3 py-2.5 text-paper" role="region" aria-label="Ações nos itens selecionados">
      <span className="mr-1 font-semibold">{plural(rows.length, "selecionado", "selecionados")}</span>
      <Button size="sm" variant="outline" className="border-ink-2 bg-transparent text-paper hover:bg-ink-2" onClick={() => rows.forEach((r) => onEdit(r, { status: "PAUSED" }))}>
        <PauseIcon aria-hidden /> Pausar
      </Button>
      <Button size="sm" variant="outline" className="border-ink-2 bg-transparent text-paper hover:bg-ink-2" onClick={() => rows.forEach((r) => onEdit(r, { status: "AVAILABLE" }))}>
        <CheckIcon aria-hidden /> Ativar
      </Button>
      <span className="ml-2">Mudar categoria</span>
      <select
        aria-label="Mudar categoria"
        className="h-[30px] rounded-md border border-ink-2 bg-ink px-2 text-paper"
        value={category}
        onChange={(e) => {
          setCategory(e.target.value);
          if (e.target.value) rows.forEach((r) => onEdit(r, { categoryId: e.target.value }));
        }}
      >
        <option value="">Escolha…</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <span className="ml-2">Ajustar preço</span>
      <input aria-label="Ajuste de preço em %" inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} className="h-[30px] w-16 rounded-md border border-ink-2 bg-ink px-2 text-right text-paper" />
      <span>%</span>
      <Button
        size="sm"
        variant="outline"
        disabled={!adjustable.length || !Number.isFinite(pct) || pct === 0}
        onClick={() => adjustable.forEach((r) => r.priceCents != null && onEdit(r, { price: centsText(adjust(parseCents(drafts[r.id]?.price ?? "") ?? r.priceCents)) }))}
      >
        Aplicar
      </Button>
      {sample && sampleNow != null && Number.isFinite(pct) && pct !== 0 && (
        <span className="text-[12px] text-[#C4BDB2]">
          {money(sampleNow)} vira {money(adjust(sampleNow))} {sample.name.length < 40 ? `na ${sample.name}` : ""}
        </span>
      )}
      {rows.length > adjustable.length && <span className="text-[12px] text-[#C4BDB2]">itens com tamanhos ficam de fora do ajuste</span>}
      <button type="button" onClick={onClear} className="ml-auto font-medium underline">
        Limpar seleção
      </button>
    </div>
  );
}
