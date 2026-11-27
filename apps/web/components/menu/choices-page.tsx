"use client";

import { useQuery } from "@tanstack/react-query";
import { ImageIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { BLOCK, ErrorNote, FilterChip, Headline, loadError, MenuPage, PageHeader, SELECT_CLASS, StatusBadge, TagChip, TEXTAREA_CLASS, Toggle, WarnNote } from "@/components/menu/bits";
import { PHOTO_TYPES, useMenu, useMenuActions, useTenantId } from "@/components/menu/use-menu";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { centsText, parseCents } from "@/lib/menu";
import { type Choice, type ChoiceKind, choicePricesText, KIND_LABEL, KIND_ORDER, plural } from "@/lib/menu-backstage";
import { cn } from "@/lib/utils";

/** A biblioteca de opções (GET /menu/:tenantId/choices). */
export function useChoices() {
  const { request } = useAuth();
  const tenantId = useTenantId();
  return useQuery({ queryKey: ["menu-choices", tenantId], queryFn: () => request<Choice[]>(`/menu/${tenantId}/choices`), enabled: Boolean(tenantId), retry: false });
}

type Filter = "all" | ChoiceKind;

/** N1: as opções que entram nos grupos de complementos (meias, tamanhos, bebidas e extras), com o editor ao lado. */
export function ChoicesPage() {
  const choices = useChoices();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  // null: nenhuma; "new": opção nova.
  const [selected, setSelected] = useState<string | "new" | null>(null);

  const header = (
    <PageHeader title="Opções" description="As escolhas que entram nos grupos de complementos: meias, tamanhos, bebidas e extras.">
      <Button onClick={() => setSelected("new")}>
        <PlusIcon aria-hidden /> Nova opção
      </Button>
    </PageHeader>
  );

  if (choices.isPending) {
    return (
      <MenuPage>
        {header}
        <div className={cn(BLOCK, "p-8 text-center text-ink-3")} aria-busy>
          Carregando as opções…
        </div>
      </MenuPage>
    );
  }
  if (choices.isError) {
    const failure = loadError(choices.error);
    return (
      <MenuPage>
        {header}
        <ErrorNote action={!failure.forbidden && <Button size="sm" variant="outline" onClick={() => choices.refetch()}>Tentar de novo</Button>}>
          {failure.forbidden ? failure.text : "Não foi possível carregar as opções. Verifique a conexão e tente de novo. Nada do que já está no cardápio mudou."}
        </ErrorNote>
      </MenuPage>
    );
  }

  const all = choices.data;
  const editing = selected === "new" ? null : (all.find((c) => c.id === selected) ?? null);
  return (
    <MenuPage>
      {header}
      {all.length === 0 && selected !== "new" ? (
        <EmptyState onNew={() => setSelected("new")} />
      ) : (
        <>
          <Summary choices={all} filter={filter} onFilter={setFilter} search={search} onSearch={setSearch} />
          <div className="flex items-start gap-4">
            <ChoiceGrid choices={all} filter={filter} search={search} selectedId={editing?.id ?? null} onSelect={setSelected} />
            {(selected === "new" || editing) && (
              <ChoiceEditor key={editing?.id ?? "new"} choice={editing} onClose={() => setSelected(null)} onCreated={(id) => setSelected(id)} />
            )}
          </div>
        </>
      )}
    </MenuPage>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <section className={cn(BLOCK, "flex flex-col items-center gap-3 px-6 py-12 text-center")}>
      <p className="font-heading text-[22px] font-bold">Nenhuma opção cadastrada · 0 opções</p>
      <p className="max-w-[520px] text-ink-2">
        Crie uma opção uma vez e use em vários grupos: a mesma &ldquo;Coca-Cola lata&rdquo; pode estar no combo, no executivo e em &ldquo;Adicionar bebida&rdquo;. O preço de venda fica em
        cada grupo.
      </p>
      <div className="flex gap-2">
        <Button onClick={onNew}>
          <PlusIcon aria-hidden /> Nova opção
        </Button>
        <Link href="/cardapio/complementos" className={buttonVariants({ variant: "outline" })}>
          Ver grupos de complementos
        </Link>
      </div>
    </section>
  );
}

function Summary({ choices, filter, onFilter, search, onSearch }: { choices: Choice[]; filter: Filter; onFilter: (f: Filter) => void; search: string; onSearch: (s: string) => void }) {
  const paused = choices.filter((c) => !c.active).length;
  const groups = new Set(choices.flatMap((c) => c.options.map((o) => o.group.id))).size;
  const orphans = choices.filter((c) => c.options.length === 0).length;
  const count = (kind: ChoiceKind) => choices.filter((c) => c.kind === kind).length;
  return (
    <Headline
      value={plural(choices.length, "opção", "opções")}
      accent={paused ? plural(paused, "pausada", "pausadas") : undefined}
      sub={`Usadas em ${plural(groups, "grupo", "grupos")} de complementos · ${orphans} fora de qualquer grupo`}
    >
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtrar por tipo">
        <FilterChip active={filter === "all"} onClick={() => onFilter("all")}>
          Todas {choices.length}
        </FilterChip>
        {KIND_ORDER.map((kind) => (
          <FilterChip key={kind} active={filter === kind} onClick={() => onFilter(kind)}>
            {KIND_LABEL[kind]} {count(kind)}
          </FilterChip>
        ))}
        <div className="relative ml-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Buscar opção" aria-label="Buscar opção" className="h-8 w-52 pl-8" />
        </div>
      </div>
    </Headline>
  );
}

function ChoiceGrid({ choices, filter, search, selectedId, onSelect }: { choices: Choice[]; filter: Filter; search: string; selectedId: string | null; onSelect: (id: string) => void }) {
  const { call } = useMenuActions();
  const term = search.trim().toLowerCase();
  const shown = choices.filter((c) => (filter === "all" || c.kind === filter) && (!term || c.name.toLowerCase().includes(term)));
  if (!shown.length) return <div className={cn(BLOCK, "flex-1 p-8 text-center text-ink-3")}>Nenhuma opção neste filtro.</div>;
  return (
    <ul className="grid min-w-0 flex-1 grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3" aria-label="Opções">
      {shown.map((choice) => {
        const groups = choice.options.map((o) => o.group.name);
        return (
          <li key={choice.id}>
            <div className={cn(BLOCK, "flex h-full flex-col overflow-hidden", selectedId === choice.id && "ring-2 ring-ink")}>
              <button type="button" onClick={() => onSelect(choice.id)} className="flex flex-1 flex-col text-left" aria-label={`Editar ${choice.name}`}>
                <div className={cn("flex h-[120px] items-center justify-center bg-surface-2", !choice.photoUrl && "border-b border-dashed border-rule")}>
                  {choice.photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- foto do restaurante vinda do armazenamento
                    <img src={choice.photoUrl} alt="" className="size-full object-cover" />
                  ) : (
                    <span className="flex flex-col items-center gap-1 text-[12px] text-ink-3">
                      <ImageIcon className="size-4" aria-hidden /> Sem foto
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-1.5 px-3 pt-2.5 pb-2">
                  <div className="flex items-start gap-2">
                    <span className={cn("min-w-0 flex-1 font-semibold", !choice.active && "text-ink-3")}>{choice.name}</span>
                    {choice.active ? <StatusBadge tone="success">Ativo</StatusBadge> : <StatusBadge tone="muted">Pausado</StatusBadge>}
                  </div>
                  {groups.length ? (
                    <>
                      <span className="text-[12.5px] text-ink-2">Usado em {plural(groups.length, "grupo", "grupos")}</span>
                      <span className="flex flex-wrap gap-1">
                        {groups.slice(0, 2).map((g) => (
                          <TagChip key={g}>{g}</TagChip>
                        ))}
                        {groups.length > 2 && <TagChip>+{groups.length - 2}</TagChip>}
                      </span>
                    </>
                  ) : (
                    <span className="text-[12.5px] text-tomate-ink">Não está em nenhum grupo</span>
                  )}
                </div>
              </button>
              <div className="px-3 pb-3 empty:hidden">
                {!choice.active ? (
                  <WarnNote
                    action={
                      <Button size="xs" variant="ghost" className="underline" onClick={() => call(`/choices/${choice.id}`, "PATCH", { active: true })}>
                        Ativar
                      </Button>
                    }
                  >
                    Pausado: fora {groups.length === 1 ? `de "${groups[0]}"` : "dos grupos"} até você ativar.
                  </WarnNote>
                ) : !groups.length ? (
                  <WarnNote tone="error" action={<Button size="xs" variant="ghost" className="underline" onClick={() => onSelect(choice.id)}>Pôr num grupo</Button>}>
                    Não aparece no cardápio.
                  </WarnNote>
                ) : !choice.photoUrl ? (
                  <WarnNote action={<Button size="xs" variant="ghost" className="underline" onClick={() => onSelect(choice.id)}>Enviar foto</Button>}>Sem foto.</WarnNote>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ChoiceEditor({ choice, onClose, onCreated }: { choice: Choice | null; onClose: () => void; onCreated: (id: string) => void }) {
  const { call, uploadTo, error } = useMenuActions();
  const menu = useMenu();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(choice?.name ?? "");
  const [kind, setKind] = useState<ChoiceKind>(choice?.kind ?? "EXTRA");
  const [code, setCode] = useState(choice?.code ?? "");
  const [cost, setCost] = useState(centsText(choice?.costCents));
  const [description, setDescription] = useState(choice?.description ?? "");
  const [active, setActive] = useState(choice?.active ?? true);
  const [inStock, setInStock] = useState(choice?.inStock ?? true);
  const [groupId, setGroupId] = useState("");
  const [groupPrice, setGroupPrice] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const freeGroups = useMemo(() => {
    const usedIn = new Set(choice?.options.map((o) => o.group.id));
    return (menu.data?.optionGroups ?? []).filter((g) => !usedIn.has(g.id));
  }, [menu.data, choice]);
  const groupsCount = choice?.options.length ?? 0;

  const save = async () => {
    setProblem(null);
    if (!name.trim()) return setProblem("Dê um nome para a opção.");
    const costCents = cost.trim() ? parseCents(cost) : null;
    if (cost.trim() && costCents === null) return setProblem("Preço de custo: informe um valor em R$, como 3,20.");
    const body = { name: name.trim(), kind, code: code.trim() || null, costCents, description: description.trim() || null, active, inStock };
    const done = choice ? await call<Choice>(`/choices/${choice.id}`, "PATCH", body) : await call<Choice>("/choices", "POST", body);
    if (!done) return;
    toast(choice ? "Opção salva." : "Opção criada.");
    if (!choice) onCreated(done.data.id);
  };

  return (
    <aside className={cn(BLOCK, "sticky top-0 flex w-[340px] shrink-0 flex-col")} aria-label={choice ? "Editar opção" : "Nova opção"}>
      <div className="flex items-center gap-2 border-b border-rule px-4 py-3.5">
        <h2 className="flex-1 font-heading text-title font-semibold">{choice ? "Editar opção" : "Nova opção"}</h2>
        {choice && (active ? <StatusBadge tone="success">Ativo</StatusBadge> : <StatusBadge tone="muted">Pausado</StatusBadge>)}
      </div>
      <div className="flex flex-col gap-3 px-4 py-4">
        {choice && (
          <div className="flex items-center gap-3">
            <div className="flex size-[84px] items-center justify-center overflow-hidden rounded-lg bg-surface-2 text-[12px] text-ink-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- foto do restaurante vinda do armazenamento */}
              {choice.photoUrl ? <img src={choice.photoUrl} alt="" className="size-full object-cover" /> : "Foto"}
            </div>
            <div className="flex flex-col gap-1">
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                {choice.photoUrl ? "Trocar foto" : "Enviar foto"}
              </Button>
              <span className="text-[12px] text-ink-3">JPG, PNG ou WEBP, até 1 MB</span>
              <input
                ref={fileRef}
                type="file"
                accept={PHOTO_TYPES.join(",")}
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file && (await uploadTo(`/choices/${choice.id}/photo`, file))) toast("Foto enviada.");
                }}
              />
            </div>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="choice-name">Nome</Label>
          <Input id="choice-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="choice-kind">Tipo</Label>
          <select id="choice-kind" className={SELECT_CLASS} value={kind} onChange={(e) => setKind(e.target.value as ChoiceKind)}>
            {KIND_ORDER.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="choice-code">Código</Label>
            <Input id="choice-code" value={code} maxLength={60} onChange={(e) => setCode(e.target.value)} />
            <span className="text-[12px] text-ink-3">Usado no PDV e na importação</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="choice-cost">Preço de custo</Label>
            <Input id="choice-cost" inputMode="decimal" placeholder="R$ 0,00" value={cost} onChange={(e) => setCost(e.target.value)} />
            <span className="text-[12px] text-ink-3">Entra na margem do relatório</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="choice-description">Descrição</Label>
          <textarea id="choice-description" rows={3} maxLength={2000} className={TEXTAREA_CLASS} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className={cn(BLOCK, "flex flex-col gap-1 px-3 py-2.5")}>
          <span className="flex items-center gap-2.5 font-medium">
            <Toggle on={inStock} label="Em estoque" onToggle={() => setInStock(!inStock)} /> Em estoque
          </span>
          <span className="text-[12.5px] text-ink-2">
            {groupsCount === 0 ? "Desligado, a opção não pode ser escolhida." : `Desligado, a opção some ${groupsCount === 1 ? "do grupo" : `dos ${groupsCount} grupos`} até você ligar de novo.`}
          </span>
        </div>
        <div className={cn(BLOCK, "flex flex-col gap-1 px-3 py-2.5")}>
          <span className="flex items-center gap-2.5 font-medium">
            <Toggle on={active} label="Ativa" onToggle={() => setActive(!active)} /> {active ? "Ativa" : "Pausada"}
          </span>
          <span className="text-[12.5px] text-ink-2">Pausada, sai do cardápio até você ativar.</span>
        </div>
        {choice && (
          <div className="flex flex-col gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-[12.5px]">
            <p>
              <span className="font-semibold">O preço de venda fica no grupo de complementos.</span> {choicePricesText(choice) ?? "Ainda não está em nenhum grupo."}
            </p>
            {choice.options.length > 0 && (
              <Link href="/cardapio/complementos" className="font-medium underline">
                Ver {choice.options.length === 1 ? "o grupo" : `os ${choice.options.length} grupos`}
              </Link>
            )}
            {freeGroups.length > 0 && (
              <div className="flex flex-wrap items-end gap-2 pt-1">
                <select aria-label="Pôr num grupo" className={cn(SELECT_CLASS, "h-8 min-w-0 flex-1")} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                  <option value="">Pôr num grupo…</option>
                  {freeGroups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
                <Input aria-label="Preço no grupo" inputMode="decimal" placeholder="R$ 0,00" value={groupPrice} onChange={(e) => setGroupPrice(e.target.value)} className="h-8 w-24" />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!groupId}
                  onClick={async () => {
                    const priceCents = groupPrice.trim() ? parseCents(groupPrice) : 0;
                    if (priceCents === null) return setProblem("Preço no grupo: informe um valor em R$, como 6,00.");
                    if (await call(`/choices/${choice.id}/groups`, "POST", { groupId, priceCents })) {
                      setGroupId("");
                      setGroupPrice("");
                      toast("Opção posta no grupo.");
                    }
                  }}
                >
                  Pôr
                </Button>
              </div>
            )}
          </div>
        )}
        {(problem || error) && <ErrorNote>{problem ?? error}</ErrorNote>}
      </div>
      <div className="flex items-center gap-2 border-t border-rule px-4 py-3">
        {choice && (
          <Button
            variant="ghost"
            className="mr-auto text-tomate"
            onClick={async () => {
              if (await call(`/choices/${choice.id}`, "DELETE")) {
                toast("Opção excluída.");
                onClose();
              }
            }}
          >
            <Trash2Icon aria-hidden /> Excluir
          </Button>
        )}
        <Button variant="outline" className={choice ? "" : "ml-auto"} onClick={onClose}>
          Cancelar
        </Button>
        <Button onClick={save}>Salvar</Button>
      </div>
    </aside>
  );
}
