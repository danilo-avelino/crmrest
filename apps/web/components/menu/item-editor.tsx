"use client";

import { useAuth } from "@/components/auth/auth-provider";
import { ImageIcon, PlusIcon, SparklesIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { ImageCropDialog } from "@/components/common/image-crop-dialog";
import { type AiFieldKey, AiMark, AllergenChip, AllergenWarning, useAiFill } from "@/components/menu/ai-fields";
import { AvailabilityEditor, type AvailabilityDraft } from "@/components/menu/availability-editor";
import { DescribeButton, SuggestionBox, useDescribeAssist } from "@/components/menu/description-assist";
import { BLOCK, ErrorNote, FIELD_LABEL, loadError, PageHeader, SELECT_CLASS, Skeleton, TEXTAREA_CLASS } from "@/components/menu/bits";
import { useMenu, useMenuActions } from "@/components/menu/use-menu";
import { useSettingsList } from "@/components/settings/use-settings";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import {
  aiProgress,
  centsText,
  groupRuleLabel,
  type MenuCategory,
  type MenuItem,
  type MenuTree,
  money,
  parseCents,
  priceLabel,
  rangesToSlots,
  slotsToRanges,
  type StoreDay,
} from "@/lib/menu";
import { CROP_PRESETS } from "@/lib/image-compress";
import { cn } from "@/lib/utils";

const TABS = [
  ["basico", "Básico"],
  ["tamanhos", "Tamanhos"],
  ["complementos", "Complementos"],
  ["disponibilidade", "Disponibilidade"],
  ["ia", "Para a IA"],
] as const;
type Tab = (typeof TABS)[number][0];

const ALLERGENS = ["Glúten", "Leite", "Ovo", "Soja", "Amendoim", "Castanhas", "Frutos do mar"];

type Draft = {
  name: string;
  categoryId: string;
  description: string;
  priceText: string;
  allowsHalf: boolean;
  sizes: { name: string; priceText: string }[];
  groupIds: string[];
  availability: AvailabilityDraft;
  ingredients: string[];
  allergens: string[];
  servesPeople: string;
  tags: string[];
  synonyms: string[];
  aiNotes: string;
  pairIds: string[];
};

function draftOf(item: MenuItem | undefined, categoryId: string): Draft {
  return {
    name: item?.name ?? "",
    categoryId: item?.categoryId ?? categoryId,
    description: item?.description ?? "",
    priceText: centsText(item?.priceCents),
    allowsHalf: item?.allowsHalf ?? true,
    sizes: (item?.sizes ?? []).map((size) => ({ name: size.name, priceText: centsText(size.priceCents) })),
    groupIds: (item?.optionGroups ?? []).map((link) => link.groupId),
    availability: { restricted: (item?.availabilities.length ?? 0) > 0, ranges: slotsToRanges(item?.availabilities ?? []) },
    ingredients: item?.ingredients ?? [],
    allergens: item?.allergens ?? [],
    servesPeople: item?.servesPeople == null ? "" : String(item.servesPeople),
    tags: item?.tags ?? [],
    synonyms: item?.synonyms ?? [],
    aiNotes: item?.aiNotes ?? "",
    pairIds: (item?.pairsWith ?? []).map((pair) => pair.pairedItemId),
  };
}

/** P2 e P4: ficha do item (Básico, Tamanhos, Complementos, Disponibilidade e Para a IA) com a prévia ao lado. `id` "novo" cria. */
export function ItemEditor({ id }: { id: string }) {
  const menu = useMenu();
  if (menu.isPending) {
    return (
      <main className="flex-1 overflow-y-auto px-6 pt-5 pb-10" aria-busy>
        <Skeleton className="mb-4 h-12 w-80" />
        <Skeleton className="h-96" />
      </main>
    );
  }
  if (menu.isError) {
    const failure = loadError(menu.error);
    return (
      <main className="flex-1 px-6 pt-5">
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
      </main>
    );
  }
  const tree = menu.data;
  const all = tree.categories.flatMap((category) => category.items);
  const item = id === "novo" ? undefined : all.find((candidate) => candidate.id === id);
  if (id !== "novo" && !item) {
    return (
      <main className="flex-1 px-6 pt-5">
        <ErrorNote
          action={
            <Link href="/cardapio" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Voltar ao cardápio
            </Link>
          }
        >
          Item não encontrado. Ele pode ter sido excluído.
        </ErrorNote>
      </main>
    );
  }
  if (tree.categories.length === 0) {
    return (
      <main className="flex-1 px-6 pt-5">
        <ErrorNote
          action={
            <Link href="/cardapio" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Criar categoria
            </Link>
          }
        >
          Crie uma categoria antes de cadastrar itens.
        </ErrorNote>
      </main>
    );
  }
  return <EditorForm key={id} tree={tree} item={item} />;
}

function EditorForm({ tree, item }: { tree: MenuTree; item: MenuItem | undefined }) {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { call, uploadPhoto, error, setError, tenantId } = useMenuActions();
  const { session } = useAuth();
  const settings = useSettingsList();
  const store = (settings.data?.find((entry) => entry.tenantId === tenantId)?.businessHours.days ?? null) as StoreDay[] | null;

  const initialTab = TABS.find(([key]) => key === params.get("aba"))?.[0] ?? "basico";
  const [tab, setTab] = useState<Tab>(initialTab);
  const firstCategory = tree.categories.find((category) => category.id === params.get("categoria"))?.id ?? tree.categories[0]!.id;
  const initial = useMemo(() => JSON.stringify(draftOf(item, firstCategory)), [item, firstCategory]);
  const [draft, setDraft] = useState<Draft>(() => JSON.parse(initial) as Draft);
  const [photo, setPhoto] = useState<File | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [saving, setSaving] = useState(false);
  const [photoSaved, setPhotoSaved] = useState(false);
  const dirty = JSON.stringify(draft) !== initial || photo !== null || removePhoto;
  const category = tree.categories.find((entry) => entry.id === draft.categoryId);
  const allItems = tree.categories.flatMap((entry) => entry.items);
  const ai = useAiFill({
    draft,
    setDraft,
    itemId: item?.id,
    categoryName: category?.name,
    knownIds: new Set(allItems.filter((other) => other.id !== item?.id && other.active).map((other) => other.id)),
    parsePrice: parseCents,
  });
  // Editar um campo preenchido pela IA tira a marca "sugerido pela IA".
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    ai.clearMark(key as AiFieldKey);
  };

  const previewUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : removePhoto ? null : (item?.photoUrl ?? null)), [photo, removePhoto, item?.photoUrl]);
  const progress = aiProgress({
    ingredients: draft.ingredients,
    allergens: draft.allergens,
    servesPeople: draft.servesPeople ? 1 : null,
    tags: draft.tags,
    synonyms: draft.synonyms,
    aiNotes: draft.aiNotes,
    pairsWith: draft.pairIds.map((pairedItemId) => ({ pairedItemId })),
  });

  async function save() {
    setError(null);
    const name = draft.name.trim();
    if (!name) return setError("Dê um nome ao item."), setTab("basico");
    if (ai.pending.length > 0) return setError("Confirme os alérgenos sugeridos pela IA antes de salvar: toque em cada um ou em Confirmar alérgenos."), setTab("ia");
    const sizes = draft.sizes.map((size) => ({ name: size.name.trim(), priceCents: parseCents(size.priceText) }));
    if (sizes.some((size) => !size.name || size.priceCents === null)) return setError("Cada tamanho precisa de nome e preço."), setTab("tamanhos");
    if (new Set(sizes.map((size) => size.name.toLowerCase())).size !== sizes.length) return setError("Dois tamanhos têm o mesmo nome."), setTab("tamanhos");
    const priceCents = sizes.length > 0 ? null : parseCents(draft.priceText);
    if (sizes.length === 0 && priceCents === null) return setError("Informe o preço ou cadastre tamanhos."), setTab("basico");
    const slots = draft.availability.restricted ? rangesToSlots(draft.availability.ranges) : { slots: [] };
    if ("error" in slots) return setError(slots.error), setTab("disponibilidade");
    const serves = draft.servesPeople.trim() ? Number(draft.servesPeople) : null;
    if (serves !== null && (!Number.isInteger(serves) || serves < 1 || serves > 100)) return setError("Serve quantas pessoas: use um número de 1 a 100."), setTab("ia");

    setSaving(true);
    try {
      const body = {
        categoryId: draft.categoryId,
        name,
        description: draft.description,
        priceCents,
        allowsHalf: draft.allowsHalf,
        ingredients: draft.ingredients,
        allergens: draft.allergens,
        servesPeople: serves,
        tags: draft.tags,
        synonyms: draft.synonyms,
        aiNotes: draft.aiNotes,
        ...(removePhoto && !photo ? { photoUrl: null } : {}),
      };
      const saved = item ? await call<MenuItem>(`/items/${item.id}`, "PATCH", body) : await call<MenuItem>("/items", "POST", body);
      if (!saved) return;
      const id = saved.data.id;
      const steps: [string, unknown][] = [
        [`/items/${id}/sizes`, { sizes: sizes.map((size) => ({ name: size.name, priceCents: size.priceCents })) }],
        [`/items/${id}/option-groups`, { groupIds: draft.groupIds }],
        [`/items/${id}/availability`, { slots: slots.slots }],
        [`/items/${id}/pairings`, { itemIds: draft.pairIds }],
      ];
      for (const [path, stepBody] of steps) {
        if (!(await call(path, "PUT", stepBody))) {
          // O item já existe: segue na ficha dele, para o próximo "Salvar" não criar outro.
          if (!item) router.replace(`/cardapio/item/${id}`);
          return;
        }
      }
      if (photo && !(await uploadPhoto(id, photo))) {
        if (!item) router.replace(`/cardapio/item/${id}`);
        return;
      }
      toast(item ? "Item atualizado" : "Item criado");
      router.push("/cardapio");
    } finally {
      setSaving(false);
    }
  }

  const flag = (key: Tab) => (key === "ia" ? `${progress.done}/${progress.total}` : key === "tamanhos" && draft.sizes.length ? String(draft.sizes.length) : null);

  // P2: a ficha do item no cardápio público (só de item salvo); o slug é o do restaurante aberto no painel.
  const tenantSlug = session?.tenants.find((tenant) => tenant.id === session.context?.tenants[0]?.id)?.slug;
  const publicItemHref = tenantSlug && item?.id ? `/c/${tenantSlug}?item=${item.id}` : null;

  return (
    <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-5 pb-10">
      <PageHeader
        crumb={
          <>
            <Link href="/cardapio" className="underline">
              Cardápio
            </Link>{" "}
            / {category?.name}
          </>
        }
        title={draft.name.trim() || "Novo item"}
      >
        {dirty && <span className="text-xs text-ink-3">Alterações não salvas</span>}
        <Link href="/cardapio" className={buttonVariants({ variant: "outline" })}>
          Cancelar
        </Link>
        <Button loading={saving} onClick={save}>
          Salvar
        </Button>
      </PageHeader>
      {error && <ErrorNote>{error}</ErrorNote>}

      <div role="tablist" aria-label="Seções do item" className="flex flex-wrap gap-1 border-b border-rule">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn("inline-flex h-10 items-center gap-1.5 border-b-2 px-3 text-[13px]", tab === key ? "border-ink font-semibold text-ink" : "border-transparent font-medium text-ink-2")}
          >
            {label}
            {flag(key) && <span className="inline-flex h-[18px] items-center rounded-sm bg-warning-lt px-1.5 text-[11px] font-semibold text-warning-ink">{flag(key)}</span>}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-4">
          {tab === "basico" && (
            <BasicTab
              draft={draft}
              set={set}
              categories={tree.categories}
              previewUrl={previewUrl}
              photoName={photo?.name}
              isNew={!item}
              photoSaved={photoSaved}
              onPhoto={async (file) => {
                setError(null);
                setPhotoSaved(false);
                setRemovePhoto(false);
                if (item) {
                  // Item já salvo: a foto sobe e é gravada na hora (o endpoint já persiste photoUrl); não suja o formulário.
                  const done = await uploadPhoto(item.id, file);
                  if (done) {
                    setPhotoSaved(true);
                    toast("Foto salva");
                  }
                } else setPhoto(file);
              }}
              onRemovePhoto={() => {
                setPhotoSaved(false);
                setPhoto(null);
                setRemovePhoto(true);
              }}
              hasPhoto={Boolean(previewUrl)}
              goSizes={() => setTab("tamanhos")}
            />
          )}
          {tab === "tamanhos" && <SizesTab draft={draft} set={set} />}
          {tab === "complementos" && <GroupsTab tree={tree} draft={draft} set={set} itemId={item?.id} />}
          {tab === "disponibilidade" && <AvailabilityEditor value={draft.availability} onChange={(value) => set("availability", value)} store={store} />}
          {tab === "ia" && <AiTab draft={draft} set={set} progress={progress} ai={ai} items={allItems.filter((other) => other.id !== item?.id && other.active)} />}
        </div>

        <aside aria-label="Prévia no cardápio" className="flex max-w-[340px] min-w-[260px] flex-1 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold">Prévia no cardápio</span>
            {publicItemHref && (
              <a href={publicItemHref} target="_blank" rel="noreferrer" className="text-[13px] font-medium underline">
                Abrir ficha
              </a>
            )}
          </div>
          <div className="overflow-hidden rounded-2xl border border-rule bg-surface">
            <div className="flex h-[150px] items-center justify-center bg-[#E9E3D9] text-[11px] text-ink-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- prévia da foto escolhida */}
              {previewUrl ? <img src={previewUrl} alt="" className="size-full object-cover" /> : "sem foto"}
            </div>
            <div className="flex flex-col gap-1 p-3">
              {draft.tags[0] && <span className="self-start rounded-full bg-tomate-lt px-2 py-px text-[11px] font-semibold text-tomate-ink">{draft.tags[0]}</span>}
              <div className="font-heading text-lg font-bold">{draft.name.trim() || "Nome do item"}</div>
              {draft.description && <div className="text-ink-2">{draft.description}</div>}
              <div className="font-semibold tabular-nums">{previewPrice(draft)}</div>
              {(draft.servesPeople || draft.allergens.length > 0) && (
                <div className="mt-1.5 border-t border-rule-soft pt-2 text-xs text-ink-3">
                  {[draft.servesPeople && `Serve ${draft.servesPeople} ${draft.servesPeople === "1" ? "pessoa" : "pessoas"}`, draft.allergens.join(", ")].filter(Boolean).join(" · ")}
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

/** Faixa dos tamanhos para o campo Preço (P2): "R$ 34,90 (Broto) a R$ 56,90 (Grande)"; um tamanho só, o preço dele. */
function sizeRange(draft: Draft): string {
  const sizes = draft.sizes.map((size) => ({ name: size.name, cents: parseCents(size.priceText) })).filter((size): size is { name: string; cents: number } => size.cents !== null);
  if (sizes.length === 0) return previewPrice(draft);
  const low = sizes.reduce((a, b) => (b.cents < a.cents ? b : a));
  const high = sizes.reduce((a, b) => (b.cents > a.cents ? b : a));
  const label = (size: { name: string; cents: number }) => `${money(size.cents)}${size.name ? ` (${size.name})` : ""}`;
  return low.cents === high.cents ? label(low) : `${label(low)} a ${label(high)}`;
}

function previewPrice(draft: Draft): string {
  const sizes = draft.sizes.map((size) => ({ name: size.name, cents: parseCents(size.priceText) })).filter((size): size is { name: string; cents: number } => size.cents !== null);
  if (sizes.length > 0) {
    const low = sizes.reduce((a, b) => (b.cents < a.cents ? b : a));
    return `a partir de ${money(low.cents)}${low.name ? ` (${low.name})` : ""}`;
  }
  const cents = parseCents(draft.priceText);
  return cents === null ? "Sem preço" : priceLabel({ priceCents: cents, sizes: [] });
}

type Setter = <K extends keyof Draft>(key: K, value: Draft[K]) => void;

function Field({ label, htmlFor, aside, children }: { label: string; htmlFor?: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between">
        <label htmlFor={htmlFor} className={FIELD_LABEL}>
          {label}
        </label>
        {aside}
      </div>
      {children}
    </div>
  );
}

function BasicTab({
  draft,
  set,
  categories,
  previewUrl,
  photoName,
  isNew,
  photoSaved,
  onPhoto,
  onRemovePhoto,
  hasPhoto,
  goSizes,
}: {
  draft: Draft;
  set: Setter;
  categories: MenuCategory[];
  previewUrl: string | null;
  photoName?: string;
  isNew: boolean;
  photoSaved: boolean;
  onPhoto: (file: File) => Promise<void>;
  onRemovePhoto: () => void;
  hasPhoto: boolean;
  goSizes: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [cropping, setCropping] = useState<File | null>(null);
  const hasSizes = draft.sizes.length > 0;
  const category = categories.find((entry) => entry.id === draft.categoryId);
  const describe = useDescribeAssist({
    name: draft.name,
    categoryName: category?.name,
    description: draft.description,
    ingredients: draft.ingredients,
    tags: draft.tags,
    servesPeople: draft.servesPeople,
  });
  return (
    <div className={cn(BLOCK, "flex flex-col gap-4 p-5")}>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Nome" htmlFor="nome">
          <Input id="nome" value={draft.name} maxLength={120} onChange={(event) => set("name", event.target.value)} />
        </Field>
        <Field label="Categoria" htmlFor="categoria">
          <select id="categoria" className={SELECT_CLASS} value={draft.categoryId} onChange={(event) => set("categoryId", event.target.value)}>
            {categories.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field
        label="Descrição"
        htmlFor="descricao"
        aside={
          <span className="flex items-center gap-2">
            <DescribeButton onImprove={describe.improve} disabled={!describe.canImprove} nameMissing={describe.nameMissing} />
            <span className="text-xs text-ink-3">{draft.description.length} de 2000</span>
          </span>
        }
      >
        <textarea id="descricao" rows={3} maxLength={2000} className={TEXTAREA_CLASS} value={draft.description} onChange={(event) => set("description", event.target.value)} />
        {describe.error && <ErrorNote>{describe.error}</ErrorNote>}
        {describe.suggestion && (
          <SuggestionBox
            suggestion={describe.suggestion}
            onUse={(text) => {
              set("description", text);
              describe.discard();
            }}
            onDiscard={describe.discard}
          />
        )}
      </Field>
      <div className="flex flex-col gap-1">
        <label htmlFor={hasSizes ? undefined : "preco"} className={FIELD_LABEL}>
          Preço
        </label>
        {hasSizes ? (
          <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2.5">
            <span>
              Vem dos tamanhos: <span className="font-semibold">{sizeRange(draft)}</span>
            </span>
            <button type="button" onClick={goSizes} className="font-medium underline">
              Editar tamanhos
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="relative w-40">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3">R$</span>
              <Input id="preco" inputMode="decimal" placeholder="0,00" value={draft.priceText} onChange={(event) => set("priceText", event.target.value)} className="pl-9 tabular-nums" />
            </div>
            <button type="button" onClick={goSizes} className="text-[12.5px] font-medium underline">
              Tem tamanhos? Cadastre na aba Tamanhos
            </button>
          </div>
        )}
      </div>
      {category?.allowsHalf && (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.allowsHalf} onChange={(event) => set("allowsHalf", event.target.checked)} />
          Pode ser pedido meio a meio
        </label>
      )}

      <div className="flex flex-col gap-1.5">
        <span className={FIELD_LABEL}>Foto</span>
        <div className="flex flex-wrap items-start gap-4">
          <div className="relative flex h-[165px] w-[220px] items-center justify-center overflow-hidden rounded-xl bg-[#E9E3D9] text-[11px] text-ink-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- prévia da foto */}
            {previewUrl ? <img src={previewUrl} alt="Foto do item" className="size-full object-cover" /> : <ImageIcon className="size-6" aria-hidden />}
          </div>
          <div className="flex min-w-[220px] flex-1 flex-col gap-2">
            <div className="text-ink-2">JPG, PNG ou WEBP. Você escolhe o enquadramento em 4:3 e a foto é comprimida para até 1 MB.</div>
            {isNew && <div className="text-xs text-ink-3">A foto é salva junto com o item</div>}
            {photoSaved && (
              <div role="status" className="flex items-center gap-2 font-medium text-success-ink">
                <span className="size-2 rounded-full bg-success" />
                Foto salva
              </div>
            )}
            {photoName && (
              <div className="flex items-center gap-2 font-medium text-success-ink">
                <span className="size-2 rounded-full bg-success" />
                {photoName} · será enviada ao salvar
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              aria-label="Escolher foto"
              onChange={async (event) => {
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
                await onPhoto(cropped);
                setCropping(null);
              }}
            />
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                {hasPhoto ? "Trocar foto" : "Enviar foto"}
              </Button>
              {hasPhoto && (
                <Button variant="ghost" size="sm" className="underline" onClick={onRemovePhoto}>
                  Remover
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SizesTab({ draft, set }: { draft: Draft; set: Setter }) {
  const update = (index: number, patch: Partial<Draft["sizes"][number]>) =>
    set("sizes", draft.sizes.map((size, i) => (i === index ? { ...size, ...patch } : size)));
  return (
    <div className={cn(BLOCK, "flex flex-col gap-3 p-5")}>
      <p className="text-ink-2">
        Com tamanhos, o preço do item vem deles (ex.: broto, média, grande). Sem tamanhos, vale o preço da aba Básico.
      </p>
      {draft.sizes.map((size, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input aria-label={`Nome do tamanho ${index + 1}`} placeholder="Ex.: Grande" value={size.name} maxLength={120} onChange={(event) => update(index, { name: event.target.value })} />
          <div className="relative w-40 shrink-0">
            <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3">R$</span>
            <Input aria-label={`Preço do tamanho ${index + 1}`} inputMode="decimal" placeholder="0,00" value={size.priceText} onChange={(event) => update(index, { priceText: event.target.value })} className="pl-9 tabular-nums" />
          </div>
          <Button variant="ghost" size="icon" aria-label={`Remover tamanho ${size.name || index + 1}`} onClick={() => set("sizes", draft.sizes.filter((_, i) => i !== index))}>
            <XIcon />
          </Button>
        </div>
      ))}
      <Button variant="outline" className="self-start" onClick={() => set("sizes", [...draft.sizes, { name: "", priceText: "" }])} disabled={draft.sizes.length >= 20}>
        <PlusIcon aria-hidden /> Tamanho
      </Button>
    </div>
  );
}

function GroupsTab({ tree, draft, set, itemId }: { tree: MenuTree; draft: Draft; set: Setter; itemId?: string }) {
  const usedIn = (groupId: string) => tree.categories.flatMap((category) => category.items).filter((item) => item.id !== itemId && item.optionGroups.some((link) => link.groupId === groupId)).length;
  return (
    <div className={cn(BLOCK, "flex flex-col gap-3 p-5")}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-ink-2">Marque os grupos que o cliente vê neste item. Mudar um grupo altera todos os itens que o usam.</p>
        <Link href="/cardapio/complementos" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Gerenciar grupos
        </Link>
      </div>
      {tree.optionGroups.length === 0 && <div className="rounded-lg bg-surface-2 px-3 py-4 text-ink-2">Nenhum grupo criado ainda. Crie o primeiro em “Gerenciar grupos”.</div>}
      {tree.optionGroups.map((group) => {
        const on = draft.groupIds.includes(group.id);
        return (
          <label key={group.id} className={cn("flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5", on ? "border-ink" : "border-rule")}>
            <input type="checkbox" checked={on} onChange={() => set("groupIds", on ? draft.groupIds.filter((id) => id !== group.id) : [...draft.groupIds, group.id])} />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{group.name}</span>
              <span className="block text-xs text-ink-3">
                {groupRuleLabel(group)} · {group.options.length} {group.options.length === 1 ? "opção" : "opções"} · usado em {usedIn(group.id) + (on ? 1 : 0)} itens
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function ChipInput({ label, hint, placeholder, values, onChange }: { label: string; hint?: React.ReactNode; placeholder: string; values: string[]; onChange: (values: string[]) => void }) {
  const [text, setText] = useState("");
  const add = () => {
    const value = text.trim();
    if (value && !values.includes(value) && values.length < 40) onChange([...values, value]);
    setText("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className={FIELD_LABEL}>
        {label} {hint && <span className="font-normal text-ink-3">{hint}</span>}
      </span>
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-input bg-surface px-1.5 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/8">
        {values.map((value) => (
          <span key={value} className="inline-flex h-6 items-center gap-0.5 rounded-sm bg-surface-2 pr-1 pl-2 text-xs font-medium">
            {value}
            <button type="button" aria-label={`Remover ${value}`} onClick={() => onChange(values.filter((other) => other !== value))} className="flex size-5 items-center justify-center text-ink-3">
              <XIcon className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          aria-label={`Adicionar ${label}`}
          placeholder={placeholder}
          value={text}
          maxLength={60}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              add();
            }
          }}
          onBlur={add}
          className="h-[26px] min-w-[120px] flex-1 bg-transparent text-[13px] outline-none placeholder:text-ink-3"
        />
      </div>
    </div>
  );
}

function AiTab({ draft, set, progress, items, ai }: { draft: Draft; set: Setter; progress: { done: number; total: number }; items: MenuItem[]; ai: ReturnType<typeof useAiFill> }) {
  const mark = (key: AiFieldKey) => (ai.marks.includes(key) ? <AiMark /> : null);
  const paired = draft.pairIds.map((id) => items.find((item) => item.id === id)).filter((item): item is MenuItem => Boolean(item));
  const available = items.filter((item) => !draft.pairIds.includes(item.id));
  return (
    <div className="flex flex-col gap-4">
      <div className={cn(BLOCK, "flex flex-wrap items-center gap-4 px-4 py-3.5")}>
        <div className="min-w-[260px] flex-1">
          <div className="font-heading text-[22px] font-bold">
            {progress.done} de {progress.total} preenchidos
          </div>
          <div className="text-ink-2">É isso que a IA usa para responder no WhatsApp e sugerir o item.</div>
          {ai.notice && <div className="mt-1 text-xs text-ink-3">{ai.notice}</div>}
        </div>
        <span title={ai.nameMissing ? "Preencha o nome" : "Preenche só os campos vazios"}>
          <Button type="button" variant="outline" size="sm" disabled={!ai.canFill} onClick={ai.fill}>
            <SparklesIcon className="text-tomate" aria-hidden />
            Preencher com IA
          </Button>
        </span>
        <div className="flex w-[200px] gap-[3px]" aria-hidden>
          {Array.from({ length: progress.total }, (_, i) => (
            <i key={i} className={cn("h-1.5 flex-1 rounded-sm", i < progress.done ? "bg-ink" : "bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-rule)]")} />
          ))}
        </div>
      </div>
      <div className={cn(BLOCK, "flex flex-col gap-[18px] p-5")}>
        {ai.error && <ErrorNote>{ai.error}</ErrorNote>}
        <ChipInput label="Ingredientes" hint={mark("ingredients")} placeholder="Digite e tecle Enter" values={draft.ingredients} onChange={(v) => set("ingredients", v)} />
        <ChipInput
          label="Apelidos"
          hint={
            <>
              (como o cliente escreve){mark("synonyms")}
            </>
          }
          placeholder="Ex.: calab"
          values={draft.synonyms}
          onChange={(v) => set("synonyms", v)}
        />
        <ChipInput label="Tags" hint={mark("tags")} placeholder="Ex.: Picante" values={draft.tags} onChange={(v) => set("tags", v)} />
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>Alérgenos{mark("allergens")}</span>
            <AllergenWarning pending={ai.pending} onConfirmAll={ai.confirmAllAllergens} />
            <div className="flex flex-wrap gap-1">
              {ALLERGENS.map((name) => {
                const on = draft.allergens.includes(name);
                return (
                  <AllergenChip
                    key={name}
                    name={name}
                    on={on}
                    unconfirmed={on && ai.pending.includes(name)}
                    onToggle={() => {
                      set("allergens", on ? draft.allergens.filter((other) => other !== name) : [...draft.allergens, name]);
                      ai.confirmAllergen(name);
                    }}
                  />
                );
              })}
            </div>
          </div>
          <Field label="Serve quantas pessoas" htmlFor="serve" aside={mark("servesPeople")}>
            <Input id="serve" inputMode="numeric" placeholder="Ex.: 2" value={draft.servesPeople} onChange={(event) => set("servesPeople", event.target.value.replace(/\D/g, ""))} className="w-32" />
          </Field>
        </div>
        <Field
          label="Observação para a IA"
          htmlFor="obs-ia"
          aside={
            <span className="text-xs text-ink-3">
              {mark("aiNotes")} {draft.aiNotes.length} de 2000
            </span>
          }
        >
          <textarea id="obs-ia" rows={2} maxLength={2000} className={TEXTAREA_CLASS} placeholder="Ex.: sugerir borda recheada" value={draft.aiNotes} onChange={(event) => set("aiNotes", event.target.value)} />
          <div className="text-xs text-ink-3">O cliente não vê esta observação.</div>
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Combina com{mark("pairIds")}</span>
          <div className="flex flex-wrap gap-2">
            {paired.map((item) => (
              <span key={item.id} className="inline-flex h-10 items-center gap-2 rounded-lg border border-rule pr-1.5 pl-3">
                {item.name}
                <button type="button" aria-label={`Remover ${item.name}`} onClick={() => set("pairIds", draft.pairIds.filter((id) => id !== item.id))} className="flex size-6 items-center justify-center text-ink-3">
                  <XIcon className="size-3.5" aria-hidden />
                </button>
              </span>
            ))}
            <select
              aria-label="Escolher item que combina"
              className={cn(SELECT_CLASS, "h-10 w-auto border-dashed border-tag-line bg-transparent font-medium")}
              value=""
              onChange={(event) => event.target.value && set("pairIds", [...draft.pairIds, event.target.value])}
            >
              <option value="">+ Escolher item</option>
              {available.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
