"use client";

import { ArchiveIcon, ArchiveRestoreIcon, CopyIcon, ExternalLinkIcon, GripVerticalIcon, ImageIcon, Loader2Icon, PencilIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { ImageCropDialog } from "@/components/common/image-crop-dialog";
import { useAuth } from "@/components/auth/auth-provider";
import { IfoodImportRequestStatus } from "@/components/menu/ifood-import-request";
import { MenuHeaderMenus } from "@/components/menu/menu-header-actions";
import { AvailabilityPill, ErrorNote, loadError, PageHeader, Skeleton, Toggle, WarnNote } from "@/components/menu/bits";
import { useMenu, useMenuActions } from "@/components/menu/use-menu";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { count } from "@/lib/format";
import { CROP_PRESETS } from "@/lib/image-compress";
import {
  brasiliaClock,
  FILTER_LABEL,
  type ItemFilter,
  type MenuCategory,
  type MenuItem,
  itemNotes,
  matchesFilter,
  menuCounts,
  moveItem,
  priceLabel,
} from "@/lib/menu";
import { cn } from "@/lib/utils";

const FILTERS: ItemFilter[] = ["all", "soldOut", "noPhoto", "outOfHours"];

/** P1: lista do cardápio com categorias arrastáveis, esgotado em 1 clique e avisos colados no item. */
export function MenuList() {
  const menu = useMenu();
  const { call, error } = useMenuActions();
  const { session } = useAuth();
  const [filter, setFilter] = useState<ItemFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const tenantSlug = session?.tenants.find((tenant) => tenant.id === session.context?.tenants[0]?.id)?.slug;
  const publicHref = tenantSlug ? `/c/${tenantSlug}` : null;
  const header = (
    <PageHeader title="Cardápio">
      {publicHref && (
        <a href={publicHref} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "ghost" })}>
          <ExternalLinkIcon aria-hidden /> Ver cardápio público
        </a>
      )}
      <MenuHeaderMenus />
      <Link href="/cardapio/item/novo" className={buttonVariants()}>
        <PlusIcon aria-hidden /> Novo item
      </Link>
    </PageHeader>
  );

  if (menu.isPending) {
    return (
      <Page>
        {header}
        <div className="flex animate-pulse flex-col gap-2.5" aria-busy aria-label="Carregando o cardápio">
          <Skeleton className="h-[92px]" />
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <Skeleton key={n} className="h-16" />
          ))}
        </div>
      </Page>
    );
  }
  if (menu.isError) {
    const failure = loadError(menu.error);
    return (
      <Page>
        {header}
        <div className="rounded-xl border border-rule bg-surface p-8">
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
        </div>
      </Page>
    );
  }

  const clock = brasiliaClock(new Date());
  const categories = sortByOrder(menu.data.categories, order);
  const counts = menuCounts(categories, clock);
  const selected = categories.find((category) => category.id === selectedId) ?? categories[0];

  if (categories.length === 0) {
    return (
      <Page>
        {header}
        <IfoodImportRequestStatus />
        {error && <ErrorNote>{error}</ErrorNote>}
        <section className="flex flex-col gap-5 rounded-xl border border-rule bg-surface p-8">
          <div>
            <h2 className="font-heading text-xl font-semibold">Seu cardápio está vazio · 0 itens</h2>
            <p className="text-ink-2">Escolha como começar. Nada vai ao ar até você publicar.</p>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
            <div className="flex flex-col gap-2 rounded-xl border border-rule p-4">
              <div className="text-sm font-semibold">Criar do zero</div>
              <p className="flex-1 text-ink-2">Cadastre item por item, com foto, tamanhos e complementos. Comece criando a primeira categoria.</p>
              <NewCategoryForm onCreate={async (name) => void (await call("/categories", "POST", { name }))} initiallyOpen />
            </div>
            {[
              ["Importar planilha (CSV)", "Baixe o modelo, preencha e envie. Você revisa os erros antes de importar.", "Importar CSV"],
              ["Foto ou PDF do cardápio", "A IA lê o cardápio impresso e monta os itens. Nada salva sem você confirmar.", "Enviar foto ou PDF"],
            ].map(([title, text, cta]) => (
              <div key={title} className="flex flex-col gap-2 rounded-xl border border-rule p-4">
                <div className="text-sm font-semibold">{title}</div>
                <p className="flex-1 text-ink-2">{text}</p>
                {title?.includes("CSV") ? (
                  <Link href="/cardapio/importar" className={buttonVariants({ variant: "outline", className: "self-start" })}>
                    {cta}
                  </Link>
                ) : (
                  <Button variant="outline" disabled title="Em breve" className="self-start">
                    {cta} (em breve)
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
      </Page>
    );
  }

  const reorder = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = categories.map((category) => category.id);
    const next = moveItem(ids, ids.indexOf(dragId), ids.indexOf(targetId));
    setOrder(next);
    setDragId(null);
    void call("/categories/order", "PUT", { ids: next }).then((done) => {
      if (!done) setOrder(null);
    });
  };

  const sections = filter === "all" ? (selected ? [selected] : []) : categories;
  const shown = sections
    .map((category) => ({ category, items: category.items.filter((item) => matchesFilter(item, category, filter, clock)) }))
    .filter((section) => filter === "all" || section.items.length > 0);
  const filterCount = (key: ItemFilter) => (key === "all" ? counts.items : key === "archived" ? counts.archived : counts[key]);

  return (
    <Page>
      {header}
      <IfoodImportRequestStatus />
      {error && <ErrorNote>{error}</ErrorNote>}

      {/* número principal com o filtro dentro */}
      <section className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-rule bg-surface px-[18px] py-4">
        <div>
          <div className="font-heading text-display leading-[1.1] font-bold tracking-[-0.5px]" aria-live="polite">
            {count(counts.items)} {counts.items === 1 ? "item" : "itens"} <span className="text-tomate">· {count(counts.soldOut)} {counts.soldOut === 1 ? "esgotado" : "esgotados"}</span>
          </div>
          <div className="text-xs text-ink-3">
            {count(counts.categories)} {counts.categories === 1 ? "categoria" : "categorias"} · {count(counts.visibleNow)} visíveis no cardápio agora
          </div>
        </div>
        <div role="group" aria-label="Filtrar itens" className="ml-auto flex flex-wrap gap-1">
          {[...FILTERS, ...(counts.archived > 0 ? (["archived"] as const) : [])].map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={cn(
                "h-7 rounded-lg border px-2.5 text-[12.5px] font-medium",
                filter === key ? "border-ink bg-ink text-paper" : "border-rule bg-surface text-ink-2 hover:bg-surface-2",
              )}
            >
              {FILTER_LABEL[key]} <span className="opacity-75">{count(filterCount(key))}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="flex flex-wrap items-start gap-4">
        {/* categorias */}
        <section aria-label="Categorias" className="max-w-[280px] min-w-60 flex-1 rounded-xl border border-rule bg-surface p-2">
          <div className="flex items-center justify-between px-2 py-1.5">
            <h2 className="font-heading text-title font-semibold">Categorias</h2>
            {newCategory === null && (
              <Button variant="ghost" size="sm" onClick={() => setNewCategory("")} className="underline">
                Nova
              </Button>
            )}
          </div>
          {newCategory !== null && (
            <NewCategoryForm
              onCreate={async (name) => {
                const done = await call("/categories", "POST", { name });
                if (done) setNewCategory(null);
              }}
              onCancel={() => setNewCategory(null)}
              initiallyOpen
            />
          )}
          <ul className="flex flex-col gap-0.5">
            {categories.map((category) => (
              <li
                key={category.id}
                draggable
                onDragStart={() => setDragId(category.id)}
                onDragEnd={() => setDragId(null)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => reorder(category.id)}
                data-testid="categoria"
                className={cn(
                  "flex h-10 items-center gap-2 rounded-lg px-2",
                  selected?.id === category.id && filter === "all" && "bg-surface-2",
                  !category.active && "opacity-60",
                  dragId === category.id && "opacity-40",
                )}
              >
                <span aria-label="Arrastar para ordenar" className="flex cursor-grab text-ink-3">
                  <GripVerticalIcon className="size-3.5" aria-hidden />
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(category.id);
                    setFilter("all");
                  }}
                  className={cn("min-w-0 flex-1 truncate text-left", selected?.id === category.id && filter === "all" && "font-semibold")}
                >
                  {category.name}
                </button>
                <span className="text-xs text-ink-3">{category.items.filter((item) => item.active).length}</span>
                <Toggle
                  on={category.active}
                  label={`Mostrar ${category.name} no cardápio`}
                  onToggle={() => call(`/categories/${category.id}`, "PATCH", { active: !category.active })}
                />
              </li>
            ))}
          </ul>
        </section>

        {/* itens */}
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-4">
          {shown.length === 0 && (
            <div className="rounded-xl border border-rule bg-surface p-8 text-center text-ink-2">
              {filter === "all" ? "Nenhum item nesta categoria ainda." : `Nenhum item em "${FILTER_LABEL[filter]}".`}
            </div>
          )}
          {shown.map(({ category, items }) => (
            <section key={category.id} aria-label={category.name} className="rounded-xl border border-rule bg-surface">
              <div className="flex flex-wrap items-baseline gap-2 border-b border-rule-soft px-4 py-3">
                {renaming === category.id ? (
                  <RenameForm
                    name={category.name}
                    onSave={async (name) => {
                      if (await call(`/categories/${category.id}`, "PATCH", { name })) setRenaming(null);
                    }}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <>
                    <h2 className="font-heading text-title font-semibold">{category.name}</h2>
                    <span className="mr-auto text-ink-3">{categorySummary(category)}</span>
                    <Button variant="ghost" size="sm" onClick={() => setRenaming(category.id)}>
                      Renomear
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        if (!window.confirm(`Excluir a categoria "${category.name}" e os itens dela? Isso não pode ser desfeito.`)) return;
                        await call(`/categories/${category.id}`, "DELETE");
                        setSelectedId(null);
                      }}
                    >
                      Excluir
                    </Button>
                  </>
                )}
              </div>
              {items.length === 0 && <div className="px-4 py-6 text-ink-2">Esta categoria ainda não tem itens.</div>}
              {items.map((item) => (
                <ItemRow key={item.id} item={item} onCall={call} />
              ))}
              <div className="px-4 py-2.5">
                <Link href={`/cardapio/item/novo?categoria=${category.id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  <PlusIcon aria-hidden /> Novo item em {category.name}
                </Link>
              </div>
            </section>
          ))}
        </div>
      </div>
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-5 pb-10">{children}</main>;
}

function categorySummary(category: MenuCategory): string {
  const active = category.items.filter((item) => item.active);
  const soldOut = active.filter((item) => item.soldOut).length;
  return `${count(active.length)} ${active.length === 1 ? "item" : "itens"}${soldOut ? ` · ${soldOut} ${soldOut === 1 ? "esgotado" : "esgotados"}` : ""}`;
}

function sortByOrder(categories: MenuCategory[], order: string[] | null): MenuCategory[] {
  if (!order) return categories;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...categories].sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
}

function NewCategoryForm({ onCreate, onCancel, initiallyOpen }: { onCreate: (name: string) => Promise<void>; onCancel?: () => void; initiallyOpen?: boolean }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  if (!initiallyOpen) return null;
  return (
    <form
      className="mb-2 flex gap-1.5 px-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        await onCreate(name.trim());
        setBusy(false);
        setName("");
      }}
    >
      <Input aria-label="Nome da categoria" placeholder="Nome da categoria" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
      <Button type="submit" loading={busy} disabled={!name.trim()}>
        Criar
      </Button>
      {onCancel && (
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      )}
    </form>
  );
}

function RenameForm({ name: initial, onSave, onCancel }: { name: string; onSave: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-1 gap-1.5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        await onSave(name.trim());
        setBusy(false);
      }}
    >
      <Input aria-label="Novo nome da categoria" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} className="max-w-xs" />
      <Button type="submit" loading={busy}>
        Salvar
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancelar
      </Button>
    </form>
  );
}

function ItemRow({ item, onCall }: { item: MenuItem; onCall: ReturnType<typeof useMenuActions>["call"] }) {
  const notes = item.active ? itemNotes(item) : [];
  const editHref = `/cardapio/item/${item.id}`;
  // Item sem foto: o quadrado tracejado abre o seletor, o enquadramento e envia na hora (sem ir ao editor).
  const { uploadPhoto, error: photoError } = useMenuActions();
  const fileRef = useRef<HTMLInputElement>(null);
  const [cropping, setCropping] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const pickPhoto = () => {
    if (!uploading) fileRef.current?.click();
  };
  return (
    <div className="flex flex-col gap-2 border-b border-rule-soft px-4 py-3 last:border-b-0" data-testid="item">
      <div className="flex flex-wrap items-center gap-3">
        {item.photoUrl ? (
          <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#E9E3D9] text-ink-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- foto do restaurante vinda do armazenamento */}
            <img src={item.photoUrl} alt="" className="size-full object-cover" />
          </span>
        ) : (
          <>
            <button
              type="button"
              aria-label={`Adicionar foto: ${item.name}`}
              title={uploading ? "Carregando…" : "Adicionar foto"}
              aria-busy={uploading}
              disabled={uploading}
              onClick={pickPhoto}
              className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dashed border-tag-line bg-surface text-ink-3 hover:bg-surface-2 disabled:opacity-55"
            >
              {uploading ? <Loader2Icon className="size-4 animate-spin" aria-hidden /> : <ImageIcon className="size-4" aria-hidden />}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              aria-label={`Escolher foto de ${item.name}`}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) setCropping(file);
              }}
            />
            <ImageCropDialog
              file={cropping}
              aspect={CROP_PRESETS.photo.aspect}
              maxWidth={CROP_PRESETS.photo.maxWidth}
              title="Enquadrar a foto"
              onCancel={() => setCropping(null)}
              onConfirm={async (cropped) => {
                setUploading(true);
                try {
                  await uploadPhoto(item.id, cropped);
                } finally {
                  setUploading(false);
                  setCropping(null);
                }
              }}
            />
          </>
        )}
        <div className="min-w-0 flex-[1_1_200px]">
          <div className={cn("truncate font-semibold", (item.soldOut || !item.active) && "opacity-55")}>{item.name}</div>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {!item.active && <Tag>Arquivado</Tag>}
            {item.tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
            {item.sizes.length > 1 && <Tag>{item.sizes.length} tamanhos</Tag>}
          </div>
        </div>
        <span className="w-[130px] text-right font-semibold tabular-nums">{priceLabel(item)}</span>
        {item.active ? (
          <AvailabilityPill
            available={!item.soldOut}
            label={`${item.name}: ${item.soldOut ? "esgotado, marcar como disponível" : "disponível, marcar como esgotado"}`}
            onToggle={() => onCall(`/items/${item.id}/sold-out`, "PUT", { soldOut: !item.soldOut })}
          />
        ) : (
          <span className="w-[124px]" />
        )}
        <div className="flex gap-0.5">
          <Button variant="ghost" size="icon-sm" aria-label={`Duplicar ${item.name}`} title="Duplicar" onClick={() => onCall(`/items/${item.id}/duplicate`, "POST")}>
            <CopyIcon />
          </Button>
          <Link href={editHref} aria-label={`Editar ${item.name}`} title="Editar" className={buttonVariants({ variant: "ghost", size: "icon-sm" })}>
            <PencilIcon />
          </Link>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${item.active ? "Arquivar" : "Desarquivar"} ${item.name}`}
            title={item.active ? "Arquivar" : "Desarquivar"}
            onClick={() => onCall(`/items/${item.id}/${item.active ? "archive" : "unarchive"}`, "POST")}
          >
            {item.active ? <ArchiveIcon /> : <ArchiveRestoreIcon />}
          </Button>
        </div>
      </div>
      {notes.map((note) => (
        <div key={note.kind} className="ml-[60px]">
          <WarnNote
            tone={note.kind === "ia" ? "error" : "warning"}
            action={
              note.kind === "photo" ? (
                <Button variant="outline" size="sm" loading={uploading} onClick={pickPhoto}>
                  {note.action}
                </Button>
              ) : (
                <Link href={`${editHref}?aba=${note.kind === "ia" ? "ia" : "basico"}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  {note.action}
                </Link>
              )
            }
          >
            {note.text}
          </WarnNote>
        </div>
      ))}
      {photoError && (
        <div className="ml-[60px]">
          <ErrorNote>{photoError}</ErrorNote>
        </div>
      )}
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex h-[21px] items-center rounded-sm border border-dashed border-tag-line px-[7px] text-[11.5px] font-medium text-ink-2">{children}</span>;
}
