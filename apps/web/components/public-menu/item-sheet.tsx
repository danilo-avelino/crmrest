"use client";

import { track } from "@/lib/attribution";
import { LoaderCircleIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  asHalfRule,
  buttonView,
  emptySelection,
  fetchPrice,
  flavorPickable,
  flavorPrice,
  groupBadge,
  groupCount,
  groupErrors,
  groupHint,
  groupKind,
  halfCandidates,
  halfRuleText,
  type ItemSelection,
  MAX_QUANTITY,
  missingChoice,
  type PriceResponse,
  priceRequestOf,
  type PricingError,
  requestKey,
  stepOption,
  toggleOption,
} from "@/lib/item-sheet";
import { type CartLine, lineOf, selectionOfLine, useCart } from "@/lib/public-cart";
import { badgesOf, fold, money, orderable, priceLabel, type PublicMenuCategory, type PublicMenuItem } from "@/lib/public-menu";
import { cn } from "@/lib/utils";
import { BadgePill } from "./item-card";
import { Sheet } from "./sheet";

/** Espera depois da última escolha antes de perguntar o preço à API. */
const PRICE_DEBOUNCE_MS = 250;
const NOTE_MAX = 140;

const CloseIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const AlertIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="shrink-0">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v6M12 16.5v.5" />
  </svg>
);

/**
 * Ficha do item (W4 a W6): tamanhos, meio a meio com a regra do preço (R7), complementos com mínimo e máximo e o
 * botão com o total vindo da API (R6: nunca "R$ 0,00"). Com `editing`, abre a linha da sacola e o botão diz "Atualizar".
 * Celular: tela cheia com a barra do botão fixa embaixo. Desktop: janela com a foto à esquerda e as opções à direita.
 */
export function ItemSheet({
  slug,
  item,
  category,
  editing,
  onClose,
}: {
  slug: string;
  item: PublicMenuItem;
  category: PublicMenuCategory | undefined;
  editing?: CartLine;
  onClose: () => void;
}) {
  const cart = useCart();
  const [selection, setSelection] = useState<ItemSelection>(() => (editing ? selectionOfLine(editing) : emptySelection(item)));
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<PricingError[]>([]);
  const [noteOpen, setNoteOpen] = useState(Boolean(editing?.note));
  const [halfQuery, setHalfQuery] = useState("");
  const [price, setPrice] = useState<{ key: string; response: PriceResponse } | null>(null);
  /** Escolha cujo pedido de preço falhou (mostra "Tentar de novo"). */
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  const can = orderable(item);
  const candidates = useMemo(() => halfCandidates(item, category), [item, category]);
  const halfRule = asHalfRule(category?.halfPricing ?? "SUM");
  const size = item.sizes.find((s) => s.id === selection.sizeId) ?? null;
  const half = candidates.find((c) => c.id === selection.halfId) ?? null;
  const missing = missingChoice(item, selection);
  const request = useMemo(() => priceRequestOf(selection), [selection]);
  const key = requestKey(request);
  const localErrors = useMemo(() => groupErrors(item, selection), [item, selection]);
  const verb = editing ? "Atualizar" : "Adicionar";

  // Preço da API a cada escolha (com espera curta); a última resposta válida fica no botão enquanto a próxima chega.
  const priceFailed = failedKey === key;
  const loading = can && !missing && price?.key !== key && !priceFailed;
  useEffect(() => {
    if (!can || missing || price?.key === key || failedKey === key) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchPrice(slug, request, controller.signal)
        .then((response) => setPrice({ key, response }))
        .catch(() => {
          if (!controller.signal.aborted) setFailedKey(key);
        });
    }, PRICE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `price` e `failedKey` ficam de fora: só a escolha (key) ou o "Tentar de novo" disparam um novo pedido.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, slug, can, missing, retry]);

  const view = buttonView(missing, price?.response ?? null, verb);
  const errorsFor = (groupId: string) => (showErrors ? (serverErrors.find((e) => e.groupId === groupId)?.message.replace(/\.$/, "") ?? localErrors[groupId]) : undefined);
  const sizeError = showErrors && missing === "size";
  const halfError = showErrors && (missing === "half" || serverErrors.some((e) => e.code.startsWith("HALF_")));
  const generalError = showErrors ? serverErrors.find((e) => !e.groupId && !e.code.startsWith("HALF_") && e.code !== "SIZE_REQUIRED") : undefined;

  const update = (next: ItemSelection) => {
    setSelection(next);
    setServerErrors([]);
  };

  const scrollToFirstError = () =>
    requestAnimationFrame(() => bodyRef.current?.querySelector("[data-error='true']")?.scrollIntoView({ behavior: "smooth", block: "center" }));

  async function submit() {
    if (missing || Object.keys(localErrors).length > 0) {
      setShowErrors(true);
      scrollToFirstError();
      return;
    }
    // Usa o preço já pedido para esta escolha; senão pergunta agora (o botão mostra "Carregando…").
    let response = price?.key === key ? price.response : null;
    if (!response) {
      try {
        response = await fetchPrice(slug, request);
      } catch {
        setFailedKey(key);
        return;
      }
      setPrice({ key, response });
    }
    if (!response.ok) {
      setServerErrors(response.errors);
      setShowErrors(true);
      scrollToFirstError();
      return;
    }
    const line = lineOf({ id: editing?.id, name: item.name, sizeName: size?.name ?? null, halfName: half?.name ?? null, selection, priced: response.line });
    if (editing) cart.update(line);
    else {
      cart.add(line);
      track(slug, "ADD_TO_CART", { itemId: line.itemId, valueCents: line.totalCents });
    }
    onClose();
  }

  const flavors = useMemo(() => {
    const q = fold(halfQuery);
    if (!q) return candidates;
    return candidates.filter((c) => fold(`${c.name} ${c.description ?? ""} ${c.ingredients.join(" ")}`).includes(q));
  }, [candidates, halfQuery]);

  const photo = item.photoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- ver ItemCard.
    <img src={item.photoUrl} alt="" decoding="async" className={cn("size-full object-cover", !can && "opacity-50")} />
  ) : null;

  return (
    <Sheet title={editing ? `Editar ${item.name}` : item.name} item onClose={onClose}>
      <div className="flex h-full flex-col lg:flex-row">
        {/* Foto em 4:3 (o formato do recorte no envio), centralizada no painel: aparece inteira, como foi enquadrada. */}
        <div className="hidden bg-[#E9E3D9] lg:flex lg:w-[44%] lg:shrink-0 lg:items-center">
          {photo && <div className="aspect-[4/3] w-full">{photo}</div>}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto pb-4">
            <div className={cn("relative bg-[#E9E3D9] lg:aspect-auto lg:h-0", photo ? "aspect-[4/3]" : "h-55")}>
              <div className="size-full lg:hidden">{photo}</div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Fechar"
                className="absolute top-3 left-3 flex size-11 items-center justify-center rounded-full bg-white/95 text-ink shadow-[0_1px_4px_rgba(26,24,20,.12)] lg:right-3 lg:left-auto"
              >
                <CloseIcon />
              </button>
            </div>

            <div className="flex flex-col gap-1.5 p-4 lg:pt-6 lg:pr-16">
              {editing && <span className="text-[12px] font-medium text-ink-3">Editar item da sacola</span>}
              {badgesOf(item).length > 0 && (
                <div className="flex gap-1.5">
                  {badgesOf(item).map((badge) => (
                    <BadgePill key={badge.label} badge={badge} />
                  ))}
                </div>
              )}
              <h1 className="m-0 font-heading text-[24px] leading-tight font-bold tracking-[-0.5px]">{item.name}</h1>
              {item.description && <p className="m-0 text-ink-2">{item.description}</p>}
              {priceLabel(item) && (
                <p className="m-0 flex items-baseline gap-2 font-semibold tabular-nums">
                  {priceLabel(item)}
                  {item.regularPriceCents != null && <s className="text-[13px] font-normal text-ink-3">{money(item.regularPriceCents)}</s>}
                </p>
              )}
            </div>

            {item.sizes.length > 0 && (
              <Section
                title="Tamanho"
                hint="Escolha 1"
                badge="Obrigatório"
                badgeTone={sizeError ? "error" : selection.sizeId ? "done" : "required"}
                error={sizeError ? "Escolha o tamanho para continuar" : undefined}
              >
                {item.sizes.map((s) => (
                  <ChoiceRow
                    key={s.id}
                    kind="radio"
                    on={selection.sizeId === s.id}
                    onClick={() => {
                      // A 2ª metade precisa ter o mesmo tamanho; se não tiver, sai.
                      const keepHalf = half && flavorPrice(half, s.name) != null;
                      update({ ...selection, sizeId: s.id, halfId: keepHalf ? selection.halfId : null });
                    }}
                    label={s.name}
                    price={money(s.priceCents)}
                    strong
                  />
                ))}
              </Section>
            )}

            {candidates.length > 0 && (
              <Section title="Sabores" hint="Inteira ou meio a meio" badge="Opcional" badgeTone="optional">
                <ChoiceRow kind="radio" on={!selection.halfMode} onClick={() => update({ ...selection, halfMode: false, halfId: null })} label="1 sabor" note="Pizza inteira" />
                <ChoiceRow kind="radio" on={selection.halfMode} onClick={() => update({ ...selection, halfMode: true })} label="2 sabores" note="Meio a meio" />
              </Section>
            )}

            {selection.halfMode && (
              <div className="mt-3.5 border-t-8 border-surface-2" data-error={halfError || undefined}>
                <div className="flex items-center gap-4 px-4 pt-5 pb-2">
                  <svg width="112" height="112" viewBox="0 0 112 112" role="img" aria-label={half ? `Pizza com metade ${item.name} e metade ${half.name}` : `Pizza com metade ${item.name} e a outra metade vazia`}>
                    <path d="M56 4 A52 52 0 0 0 56 108 Z" fill="#B5522D" />
                    <path
                      d="M56 4 A52 52 0 0 1 56 108 Z"
                      fill={half ? "var(--menu-accent)" : "#FFFFFF"}
                      stroke={half ? "var(--menu-accent)" : "#C4BDB2"}
                      strokeWidth="2"
                      strokeDasharray={half ? "0" : "5 4"}
                    />
                    <line x1="56" y1="4" x2="56" y2="108" stroke="#FFFFFF" strokeWidth="3" />
                  </svg>
                  <div className="flex flex-1 flex-col gap-2">
                    <div className="flex items-baseline gap-2">
                      <span className="w-14 text-[11px] text-ink-3">1ª metade</span>
                      <span className="font-semibold">{item.name}</span>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <span className="w-14 text-[11px] text-ink-3">2ª metade</span>
                      <span className={cn("font-semibold", !half && "text-ink-3")}>{half?.name ?? "Escolha abaixo"}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="rounded-sm bg-ink px-2 py-0.5 text-[11px] font-semibold text-white tabular-nums">{half ? "2 de 2" : "1 de 2"}</span>
                      {size && <span className="text-[12px] text-ink-3">{size.name}</span>}
                    </div>
                  </div>
                </div>

                <div className="mx-4 mt-2 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-ink-2">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="mt-0.5 shrink-0">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 11v6M12 7.5v.5" />
                  </svg>
                  <div>
                    <span className="font-semibold text-ink">{halfRuleText(halfRule)}</span> Cada sabor abaixo mostra o preço da sua metade
                    {size ? ` no tamanho ${size.name.toLowerCase()}` : ""}.
                  </div>
                </div>

                <div className="px-4 pt-3.5 pb-1.5">
                  <label htmlFor="busca-sabor" className="mb-1.5 block font-medium">
                    Escolha a 2ª metade
                  </label>
                  <div className="relative">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="absolute top-3.5 left-3 text-ink-3">
                      <circle cx="11" cy="11" r="7" />
                      <path d="M20 20l-3.5-3.5" />
                    </svg>
                    <input
                      id="busca-sabor"
                      type="search"
                      value={halfQuery}
                      onChange={(event) => setHalfQuery(event.target.value)}
                      placeholder="Buscar sabor ou ingrediente"
                      className="h-11 w-full rounded-lg border border-rule bg-surface pr-3 pl-9 text-[14px] outline-none focus:border-ink focus:shadow-[0_0_0_3px_rgba(26,24,20,.08)]"
                    />
                  </div>
                </div>
                {halfError && (
                  <p role="alert" className="mx-4 mt-2 mb-0 flex items-center gap-1.5 font-medium text-tomate">
                    <AlertIcon />
                    {serverErrors.find((e) => e.code.startsWith("HALF_"))?.message.replace(/\.$/, "") ?? "Escolha a 2ª metade para continuar"}
                  </p>
                )}
                <div className="flex flex-col px-4">
                  {flavors.map((flavor) => {
                    const cents = flavorPrice(flavor, size?.name ?? null);
                    const pickable = flavorPickable(flavor, size?.name ?? null);
                    const tag = !orderable(flavor) ? (flavor.soldOut ? "esgotado" : "indisponível") : cents == null ? `sem ${size?.name.toLowerCase()}` : size ? "metade" : "a partir de";
                    return (
                      <ChoiceRow
                        key={flavor.id}
                        kind="radio"
                        on={selection.halfId === flavor.id}
                        disabled={!pickable}
                        onClick={() => update({ ...selection, halfId: flavor.id })}
                        label={flavor.name}
                        note={flavor.description ?? flavor.ingredients.join(", ")}
                        price={cents != null ? money(cents) : undefined}
                        tag={tag}
                        thumb={flavor.photoUrl}
                      />
                    );
                  })}
                  {flavors.length === 0 && <p className="m-0 py-4 text-ink-3">Nenhum sabor com “{halfQuery}”.</p>}
                </div>
              </div>
            )}

            {item.optionGroups.map((group) => {
              const hint = groupHint(group, selection);
              const error = errorsFor(group.id);
              const kind = groupKind(group);
              return (
                <Section
                  key={group.id}
                  title={group.name}
                  hint={hint.text}
                  hintTone={hint.complete ? "done" : undefined}
                  badge={hint.complete ? `${groupBadge(group)} ✓` : groupBadge(group)}
                  badgeTone={error ? "error" : hint.complete ? "done" : group.minSelect > 0 ? "required" : "optional"}
                  error={error}
                >
                  {group.options.map((option) => {
                    const count = selection.options[option.id] ?? 0;
                    const priceText = option.priceCents > 0 ? `+ ${money(option.priceCents)}` : undefined;
                    if (kind === "count") {
                      return (
                        <div key={option.id} className={cn("flex min-h-15 items-center gap-3 border-b border-[#EEE9E2]", option.soldOut && "opacity-50")}>
                          <span className="flex-1">
                            <span className="block font-medium">{option.name}</span>
                            {option.soldOut ? (
                              <span className="block text-[12px] font-medium text-tomate">Em falta hoje</span>
                            ) : (
                              priceText && <span className="block text-[12px] text-ink-3 tabular-nums">{priceText}</span>
                            )}
                          </span>
                          <Stepper
                            small
                            value={count}
                            label={option.name}
                            onDec={() => update(stepOption(group, selection, option.id, -1))}
                            onInc={() => update(stepOption(group, selection, option.id, 1))}
                            decDisabled={count === 0}
                            incDisabled={option.soldOut || groupCount(group, selection) >= group.maxSelect}
                          />
                        </div>
                      );
                    }
                    return (
                      <ChoiceRow
                        key={option.id}
                        kind={kind === "single" ? "radio" : "check"}
                        on={count > 0}
                        disabled={option.soldOut}
                        onClick={() => update(toggleOption(group, selection, option.id))}
                        label={option.name}
                        price={priceText}
                        tag={option.soldOut ? "Em falta" : undefined}
                      />
                    );
                  })}
                </Section>
              );
            })}

            {(item.servesPeople != null || item.allergens.length > 0 || item.ingredients.length > 0) && (
              <div className="mt-4 flex flex-col gap-2.5 border-t-8 border-surface-2 px-4 py-3.5">
                <h2 className="m-0 font-heading text-title font-semibold">Detalhes</h2>
                {(item.servesPeople != null || item.allergens.length > 0) && (
                  <div className="grid grid-cols-2 gap-2.5">
                    {item.servesPeople != null && (
                      <div>
                        <div className="text-[12px] text-ink-3">Serve</div>
                        <div className="font-medium">{item.servesPeople === 1 ? "1 pessoa" : `${item.servesPeople} pessoas`}</div>
                      </div>
                    )}
                    {item.allergens.length > 0 && (
                      <div>
                        <div className="text-[12px] text-ink-3">Alérgenos</div>
                        <div className="font-medium">{item.allergens.join(", ")}</div>
                      </div>
                    )}
                  </div>
                )}
                {item.ingredients.length > 0 && (
                  <div>
                    <div className="text-[12px] text-ink-3">Ingredientes</div>
                    <div>{item.ingredients.join(", ")}.</div>
                  </div>
                )}
              </div>
            )}

            <div className={cn("border-t-8 border-surface-2 px-4 py-1.5", item.servesPeople == null && item.allergens.length === 0 && item.ingredients.length === 0 && "mt-4")}>
              {noteOpen ? (
                <div className="flex flex-col gap-1.5 py-2.5">
                  <label htmlFor="observacao" className="font-medium">
                    Observação
                  </label>
                  <textarea
                    id="observacao"
                    value={selection.note}
                    maxLength={NOTE_MAX}
                    rows={2}
                    autoFocus={!editing}
                    onChange={(event) => setSelection({ ...selection, note: event.target.value })}
                    placeholder="Ex.: sem cebola, bem passada"
                    className="w-full resize-none rounded-lg border border-rule bg-surface px-3 py-2 text-[14px] outline-none focus:border-ink focus:shadow-[0_0_0_3px_rgba(26,24,20,.08)]"
                  />
                  <span className="self-end text-[11px] text-ink-3 tabular-nums">
                    {selection.note.length}/{NOTE_MAX}
                  </span>
                </div>
              ) : (
                <button type="button" aria-expanded="false" onClick={() => setNoteOpen(true)} className="flex h-12 w-full items-center gap-2.5 text-left font-medium">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="text-ink-2">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  <span className="flex-1">Adicionar observação</span>
                  <span className="font-normal text-ink-3">opcional</span>
                </button>
              )}
            </div>
          </div>

          {(generalError || priceFailed) && (
            <div role="alert" className="flex items-center gap-1.5 border-t border-rule bg-tomate-lt px-4 py-2 font-medium text-tomate">
              <AlertIcon />
              <span className="flex-1">{generalError ? generalError.message : "Não deu para calcular o preço."}</span>
              {priceFailed && !generalError && (
                <button type="button" onClick={() => {
                    setFailedKey(null);
                    setRetry((n) => n + 1);
                  }} className="h-9 font-semibold underline underline-offset-3">
                  Tentar de novo
                </button>
              )}
            </div>
          )}

          <div className="flex shrink-0 items-center gap-2.5 border-t border-rule bg-surface px-4 pt-3 pb-4">
            <Stepper
              value={selection.quantity}
              label="quantidade"
              onDec={() => update({ ...selection, quantity: Math.max(1, selection.quantity - 1) })}
              onInc={() => update({ ...selection, quantity: Math.min(MAX_QUANTITY, selection.quantity + 1) })}
              decDisabled={!can || selection.quantity <= 1}
              incDisabled={!can || selection.quantity >= MAX_QUANTITY}
            />
            {can ? (
              <Button
                onClick={submit}
                aria-disabled={view.tone === "blocked" || undefined}
                className={cn(
                  "h-12 flex-1 bg-(--menu-accent) text-[14px] text-white hover:bg-(--menu-accent) hover:opacity-90",
                  view.tone === "blocked" && "opacity-55 hover:opacity-55",
                )}
              >
                {loading && view.tone === "ready" && <LoaderCircleIcon className="animate-spin" aria-hidden />}
                <span className="tabular-nums">{loading && view.tone === "blocked" && !missing ? "Calculando…" : view.label}</span>
              </Button>
            ) : (
              <Button disabled className="h-12 flex-1 bg-[#E4DFD7] text-[14px] text-ink-2">
                {item.soldOut ? "Esgotado" : "Indisponível agora"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Sheet>
  );
}

// ---------- Peças ----------

const BADGE_TONES = {
  required: "bg-ink text-white",
  optional: "bg-surface-2 text-ink-2",
  done: "bg-success-lt text-success-ink",
  error: "bg-tomate text-white",
} as const;

function Section({
  title,
  hint,
  hintTone,
  badge,
  badgeTone,
  error,
  children,
}: {
  title: string;
  hint: string;
  hintTone?: "done";
  badge: string;
  badgeTone: keyof typeof BADGE_TONES;
  error?: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-3.5 border-t-8 border-surface-2" data-error={error ? "true" : undefined}>
      <div className={cn("flex items-center justify-between px-4 pt-3.5 pb-2.5", error && "bg-tomate-lt")}>
        <div>
          <h2 className="m-0 font-heading text-title font-semibold">{title}</h2>
          <div className={cn("text-[12px] tabular-nums", hintTone === "done" ? "font-medium text-success-ink" : "text-ink-3")}>{hint}</div>
        </div>
        <span className={cn("rounded-sm px-2 py-0.5 text-[11px] font-semibold", BADGE_TONES[badgeTone])}>{badge}</span>
      </div>
      <div className={cn("flex flex-col px-4", error && "mx-4 rounded-xl border-[1.5px] border-tomate")}>{children}</div>
      {error && (
        <p role="alert" className="mx-4 mt-2 mb-0 flex items-center gap-1.5 font-medium text-tomate">
          <AlertIcon />
          {error}
        </p>
      )}
    </section>
  );
}

function ChoiceRow({
  kind,
  on,
  disabled = false,
  onClick,
  label,
  note,
  price,
  tag,
  thumb,
  strong = false,
}: {
  kind: "radio" | "check";
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  note?: string;
  price?: string;
  tag?: string;
  thumb?: string | null;
  strong?: boolean;
}) {
  return (
    <button
      type="button"
      role={kind === "radio" ? "radio" : "checkbox"}
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex min-h-12 w-full items-center gap-3 border-b border-[#EEE9E2] py-2 text-left last:border-b-0 disabled:cursor-not-allowed disabled:opacity-50",
        thumb !== undefined && "min-h-16",
      )}
    >
      {kind === "radio" ? (
        <span className={cn("size-5 shrink-0 rounded-full", on ? "border-[6px] border-ink" : "border-2 border-[#C4BDB2]")} />
      ) : (
        <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-sm border-2", on ? "border-ink bg-ink" : "border-[#C4BDB2] bg-surface")}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12l5 5 9-10" />
          </svg>
        </span>
      )}
      {thumb !== undefined &&
        (thumb ? (
          // eslint-disable-next-line @next/next/no-img-element -- ver ItemCard.
          <img src={thumb} alt="" width={44} height={44} loading="lazy" className="size-11 shrink-0 rounded-lg object-cover" />
        ) : (
          <span className="size-11 shrink-0 rounded-lg bg-[#E9E3D9]" />
        ))}
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        {note && <span className="block truncate text-[12px] text-ink-3">{note}</span>}
      </span>
      {(price || tag) && (
        <span className="text-right tabular-nums">
          {price && <span className={cn("block", strong ? "font-semibold" : "text-ink-2")}>{price}</span>}
          {tag && <span className="block text-[11px] text-ink-3">{tag}</span>}
        </span>
      )}
    </button>
  );
}

function Stepper({
  value,
  label,
  onDec,
  onInc,
  decDisabled,
  incDisabled,
  small = false,
}: {
  value: number;
  label: string;
  onDec: () => void;
  onInc: () => void;
  decDisabled: boolean;
  incDisabled: boolean;
  small?: boolean;
}) {
  const btn = cn("flex items-center justify-center text-[18px] disabled:text-ink-3 disabled:opacity-50", small ? "h-[34px] w-9" : "h-[46px] w-11");
  return (
    <span className={cn("flex shrink-0 items-center rounded-lg border border-rule", small ? "h-9" : "h-12")}>
      <button type="button" className={btn} onClick={onDec} disabled={decDisabled} aria-label={`Menos ${label}`}>
        −
      </button>
      <span className="w-5 text-center font-semibold tabular-nums" aria-live="polite">
        {value}
      </span>
      <button type="button" className={btn} onClick={onInc} disabled={incDisabled} aria-label={`Mais ${label}`}>
        +
      </button>
    </span>
  );
}
