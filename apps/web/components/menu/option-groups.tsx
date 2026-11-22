"use client";

import { PlusIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AvailabilityPill, BLOCK, ErrorNote, loadError, PageHeader, Skeleton, Toggle } from "@/components/menu/bits";
import { useMenu, useMenuActions } from "@/components/menu/use-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { centsText, groupRuleLabel, HALF_RULES, type HalfPricing, type MenuCategory, type MenuOption, type MenuOptionGroup, type MenuTree, parseCents } from "@/lib/menu";
import { cn } from "@/lib/utils";

/** P3: grupos de complementos (reaproveitados em vários itens) e a regra do meio a meio. */
export function OptionGroups() {
  const menu = useMenu();
  const { call, error } = useMenuActions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const header = (
    <PageHeader
      crumb={
        <Link href="/cardapio" className="underline">
          Cardápio
        </Link>
      }
      title="Grupos de complementos"
    >
      <Button
        onClick={async () => {
          const done = await call<MenuOptionGroup>("/option-groups", "POST", { name: "Novo grupo", minSelect: 0, maxSelect: 1 });
          if (done) setSelectedId(done.data.id);
        }}
      >
        <PlusIcon aria-hidden /> Novo grupo
      </Button>
    </PageHeader>
  );

  if (menu.isPending) {
    return (
      <Page>
        {header}
        <div className="flex animate-pulse gap-4" aria-busy aria-label="Carregando os grupos">
          <Skeleton className="h-64 w-72" />
          <Skeleton className="h-64 flex-1" />
        </div>
      </Page>
    );
  }
  if (menu.isError) {
    const failure = loadError(menu.error);
    return (
      <Page>
        {header}
        <ErrorNote
          action={
            !failure.forbidden && (
              <Button size="sm" variant="outline" onClick={() => menu.refetch()}>
                Tentar de novo
              </Button>
            )
          }
        >
          {failure.text}
        </ErrorNote>
      </Page>
    );
  }

  const tree = menu.data;
  const selected = tree.optionGroups.find((group) => group.id === selectedId) ?? tree.optionGroups[0];
  return (
    <Page>
      {header}
      {error && <ErrorNote>{error}</ErrorNote>}
      {tree.optionGroups.length === 0 ? (
        <div className={cn(BLOCK, "p-8 text-center text-ink-2")}>Nenhum grupo ainda. Crie o primeiro (borda, adicionais, bebida do combo) e ligue aos itens.</div>
      ) : (
        <div className="flex flex-wrap items-start gap-4">
          <ul aria-label="Grupos" className="flex max-w-[320px] min-w-64 flex-1 flex-col gap-2">
            {tree.optionGroups.map((group) => (
              <li key={group.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(group.id)}
                  aria-current={selected?.id === group.id}
                  className={cn("flex w-full flex-col gap-0.5 rounded-xl border border-rule px-3.5 py-3 text-left", selected?.id === group.id ? "bg-surface-2" : "bg-surface")}
                >
                  <span className="flex items-center gap-2">
                    <span className="font-semibold">{group.name}</span>
                    <span className={cn("rounded-sm px-1.5 text-[11px] font-semibold", group.minSelect >= 1 ? "bg-ink text-paper" : "bg-surface-2 text-ink-2")}>{group.minSelect >= 1 ? "Obrigatório" : "Opcional"}</span>
                  </span>
                  <span className="text-xs text-ink-3">
                    {group.maxSelect === 1 ? "escolha 1" : `até ${group.maxSelect}`} · usado em {usedItems(tree, group.id).length} itens
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-4">
            {selected && <GroupEditor key={selected.id} group={selected} tree={tree} onDeleted={() => setSelectedId(null)} />}
            <HalfAndHalf categories={tree.categories} />
          </div>
        </div>
      )}
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-5 pb-10">{children}</main>;
}

const usedItems = (tree: MenuTree, groupId: string) =>
  tree.categories.flatMap((category) => category.items).filter((item) => item.optionGroups.some((link) => link.groupId === groupId));

function GroupEditor({ group, tree, onDeleted }: { group: MenuOptionGroup; tree: MenuTree; onDeleted: () => void }) {
  const { call, error } = useMenuActions();
  const toast = useToast();
  const [name, setName] = useState(group.name);
  const [min, setMin] = useState(String(group.minSelect));
  const [max, setMax] = useState(String(group.maxSelect));
  const required = Number(min) >= 1;
  const used = usedItems(tree, group.id);
  const minN = Number(min);
  const maxN = Number(max);
  const invalid = !name.trim() || !Number.isInteger(minN) || !Number.isInteger(maxN) || maxN < 1 || minN < 0 || minN > maxN;
  const dirty = name !== group.name || minN !== group.minSelect || maxN !== group.maxSelect;

  return (
    <section className={cn(BLOCK, "flex flex-col gap-4 p-5")} aria-label={`Grupo ${group.name}`}>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="grid grid-cols-[minmax(0,2fr)_auto_80px_80px] items-end gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="gnome" className="text-[13px]">
            Nome do grupo
          </Label>
          <Input id="gnome" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </div>
        <div role="radiogroup" aria-label="Tipo do grupo" className="flex overflow-hidden rounded-lg border border-rule">
          {[
            ["Obrigatório", true],
            ["Opcional", false],
          ].map(([label, isRequired]) => (
            <button
              key={String(label)}
              type="button"
              role="radio"
              aria-checked={required === isRequired}
              onClick={() => {
                if (isRequired && !required) setMin("1");
                if (!isRequired && required) setMin("0");
              }}
              className={cn("h-9 px-3 text-[13px] font-medium", required === isRequired ? "bg-ink text-paper" : "bg-surface text-ink-2")}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="gmin" className="text-[13px]">
            Mínimo
          </Label>
          <Input id="gmin" inputMode="numeric" value={min} onChange={(event) => setMin(event.target.value.replace(/\D/g, ""))} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="gmax" className="text-[13px]">
            Máximo
          </Label>
          <Input id="gmax" inputMode="numeric" value={max} onChange={(event) => setMax(event.target.value.replace(/\D/g, ""))} />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="mr-auto text-ink-2">
          O cliente vê: <span className="font-medium text-ink">“{invalid ? "confira os campos" : groupRuleLabel({ name: name.trim(), minSelect: minN, maxSelect: maxN })}”</span>
        </div>
        <Button
          disabled={!dirty || invalid}
          onClick={async () => {
            if (await call(`/option-groups/${group.id}`, "PATCH", { name: name.trim(), minSelect: minN, maxSelect: maxN })) toast("Grupo salvo");
          }}
        >
          Salvar grupo
        </Button>
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-xs text-ink-3">
            <th className="py-1.5 font-medium">Opção</th>
            <th className="w-32 py-1.5 font-medium">Preço</th>
            <th className="w-36 py-1.5 font-medium">Disponível</th>
            <th className="w-12 py-1.5 font-medium">
              <span className="sr-only">Remover</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {group.options.map((option) => (
            <OptionRow key={option.id} option={option} call={call} />
          ))}
        </tbody>
      </table>
      {group.options.length === 0 && <div className="text-ink-2">Este grupo ainda não tem opções.</div>}
      <Button variant="outline" className="self-start" onClick={() => call(`/option-groups/${group.id}/options`, "POST", { name: "Nova opção", priceCents: 0 })}>
        <PlusIcon aria-hidden /> Opção
      </Button>

      <div className="flex flex-wrap items-center gap-2 border-t border-rule-soft pt-4">
        <span className="font-semibold">
          Usado em {used.length} {used.length === 1 ? "item" : "itens"}
        </span>
        {used.slice(0, 8).map((item) => (
          <Link key={item.id} href={`/cardapio/item/${item.id}?aba=complementos`} className="rounded-sm border border-dashed border-tag-line px-2 py-0.5 text-xs font-medium text-ink-2 no-underline">
            {item.name}
          </Link>
        ))}
        {used.length > 8 && <span className="text-xs text-ink-3">e mais {used.length - 8}</span>}
        {used.length === 0 && <span className="text-ink-3">Ligue o grupo na aba Complementos de cada item.</span>}
        <Button
          variant="destructive"
          size="sm"
          className="ml-auto"
          onClick={async () => {
            if (!window.confirm(`Excluir o grupo "${group.name}"? Ele sai dos ${used.length} itens que o usam.`)) return;
            if (await call(`/option-groups/${group.id}`, "DELETE")) onDeleted();
          }}
        >
          Excluir grupo
        </Button>
      </div>
      {used.length > 0 && <div className="text-xs text-ink-3">Mudar este grupo altera os {used.length} itens de uma vez.</div>}
    </section>
  );
}

function OptionRow({ option, call }: { option: MenuOption; call: ReturnType<typeof useMenuActions>["call"] }) {
  const [name, setName] = useState(option.name);
  const [price, setPrice] = useState(centsText(option.priceCents));
  const save = async () => {
    const cents = parseCents(price);
    if (!name.trim() || cents === null) {
      setName(option.name);
      setPrice(centsText(option.priceCents));
      return;
    }
    if (name.trim() !== option.name || cents !== option.priceCents) await call(`/options/${option.id}`, "PATCH", { name: name.trim(), priceCents: cents });
  };
  return (
    <tr className="border-t border-rule-soft">
      <td className="py-2 pr-2">
        <Input aria-label="Nome da opção" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} onBlur={save} />
      </td>
      <td className="py-2 pr-2">
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" aria-hidden>
            R$
          </span>
          <Input aria-label={`Preço de ${option.name}`} inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} onBlur={save} className="pl-9 tabular-nums" />
        </div>
      </td>
      <td className="py-2 pr-2">
        <AvailabilityPill
          available={!option.soldOut}
          label={`${option.name}: ${option.soldOut ? "esgotada, marcar como disponível" : "disponível, marcar como esgotada"}`}
          onToggle={() => call(`/options/${option.id}`, "PATCH", { soldOut: !option.soldOut })}
        />
      </td>
      <td className="py-2">
        <Button variant="ghost" size="icon-sm" aria-label={`Remover ${option.name}`} onClick={() => call(`/options/${option.id}`, "DELETE")}>
          <XIcon />
        </Button>
      </td>
    </tr>
  );
}

/** Meio a meio: liga por categoria; a regra de preço vale para todas as categorias ligadas. */
function HalfAndHalf({ categories }: { categories: MenuCategory[] }) {
  const { call, error } = useMenuActions();
  const on = categories.filter((category) => category.allowsHalf);
  const rule: HalfPricing = on[0]?.halfPricing ?? "MAX";
  const text = HALF_RULES.find((entry) => entry.value === rule)?.text ?? "";
  return (
    <section className={cn(BLOCK, "flex flex-col gap-4 p-5")} aria-label="Meio a meio">
      <h2 className="font-heading text-title font-semibold">Meio a meio</h2>
      {error && <ErrorNote>{error}</ErrorNote>}
      {categories.length === 0 && <div className="text-ink-2">Crie categorias para ligar o meio a meio.</div>}
      <div className="flex flex-wrap gap-4">
        {categories.map((category) => (
          <span key={category.id} className="inline-flex items-center gap-2">
            {category.name}
            <Toggle on={category.allowsHalf} label={`Meio a meio em ${category.name}`} onToggle={() => call(`/categories/${category.id}`, "PATCH", { allowsHalf: !category.allowsHalf })} />
            <span className={cn("text-xs", category.allowsHalf ? "text-success-ink" : "text-ink-3")}>{category.allowsHalf ? "Ligado" : "Desligado"}</span>
          </span>
        ))}
      </div>
      <div role="radiogroup" aria-label="Regra de preço" className="grid grid-cols-3 gap-3">
        {HALF_RULES.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="radio"
            aria-checked={rule === entry.value}
            disabled={on.length === 0}
            onClick={async () => {
              for (const category of on) if (!(await call(`/categories/${category.id}`, "PATCH", { halfPricing: entry.value }))) return;
            }}
            className={cn("flex flex-col gap-0.5 rounded-lg px-3.5 py-3 text-left disabled:opacity-55", rule === entry.value ? "border-2 border-ink" : "border border-rule")}
          >
            <span className="font-semibold">{entry.name}</span>
            <span className="text-xs text-ink-3">{entry.text}</span>
          </button>
        ))}
      </div>
      <div className="text-ink-2">
        O cliente vê: <span className="font-medium text-ink">“{text}”</span>
      </div>
    </section>
  );
}
