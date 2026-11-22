"use client";

import { MinusIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { ChevronRightIcon, TicketPercentIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { couponEffect, couponSummary, selectCoupon, useCoupons, useSelectedCoupon } from "@/lib/coupons";
import { Button } from "@/components/ui/button";
import {
  type BagStore,
  bagButton,
  checkKey,
  deliveryLine,
  freeDeliveryProgress,
  freeDeliveryRemaining,
  itemsLabel,
  type LineCheck,
  lineGone,
  reconcileLine,
  referenceCents,
  requestOfLine,
  subtotalOf,
  suggestionsOf,
} from "@/lib/bag";
import { fetchPrice, MAX_QUANTITY } from "@/lib/item-sheet";
import { type CartLine, useCart } from "@/lib/public-cart";
import { highlightsOf, money, type PublicMenuCategory, type PublicMenuItem, visibleCategories } from "@/lib/public-menu";
import { cn } from "@/lib/utils";
import { ItemSheet } from "./item-sheet";
import { Sheet } from "./sheet";

/**
 * Sacola (W7): coluna lateral sempre visível no desktop; no celular, barra fixa embaixo e a sacola em tela cheia.
 * Um só dono do estado: confere o preço de cada linha na API quando a sacola abre ("O preço mudou de X para Y")
 * e marca o que esgotou depois de entrar ("Trocar" / "Remover"). A sacola vive no navegador (sem endpoint de carrinho).
 */
export function Bag({ slug, store, categories, top }: { slug: string; store: BagStore; categories: PublicMenuCategory[]; top?: ReactNode }) {
  const cart = useCart();
  const { lines } = cart;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CartLine | null>(null);
  const [adding, setAdding] = useState<PublicMenuItem | null>(null);
  const [checks, setChecks] = useState<Record<string, LineCheck>>({});
  const checked = useRef(new Set<string>());

  const visible = useMemo(() => visibleCategories(categories), [categories]);
  const items = useMemo(() => new Map(visible.flatMap((c) => c.items).map((i) => [i.id, i])), [visible]);
  const highlights = useMemo(() => highlightsOf(visible), [visible]);

  // Sacola aberta de novo: confere tudo outra vez.
  useEffect(() => {
    if (open) checked.current.clear();
  }, [open]);

  // Confere o preço de cada linha ainda não conferida; preço novo vale e a linha ganha o aviso.
  const keys = lines.map(checkKey).join("|");
  useEffect(() => {
    const controller = new AbortController();
    for (const line of lines) {
      const key = checkKey(line);
      if (checked.current.has(key)) continue;
      checked.current.add(key);
      fetchPrice(slug, requestOfLine(line), controller.signal)
        .then((response) => {
          const result = reconcileLine(line, response);
          setChecks((current) => ({ ...current, [line.id]: result.check }));
          if (result.check.kind === "changed" && result.unitCents != null && result.totalCents != null) {
            cart.update({ ...line, unitCents: result.unitCents, totalCents: result.totalCents, pricedAt: Date.now() });
          }
        })
        .catch(() => checked.current.delete(key));
    }
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, slug]);

  const subtotal = subtotalOf(lines);
  const unavailable = lines.filter((l) => checks[l.id]?.kind === "unavailable" || lineGone(l, items)).length;
  const button = bagButton(store, { subtotalCents: subtotal, count: lines.length, unavailable });
  const summary = `${itemsLabel(lines)} · ${money(subtotal)}`;

  const panel = (
    <BagPanel
      slug={slug}
      store={store}
      categories={visible}
      highlights={highlights}
      items={items}
      checks={checks}
      onEdit={setEditing}
      onSuggest={setAdding}
      button={button}
    />
  );
  const editingItem = editing ? items.get(editing.itemId) : undefined;

  return (
    <>
      <div className="sticky top-20 hidden max-h-[calc(100dvh-6rem)] w-80 shrink-0 flex-col gap-3 self-start lg:flex">
        {top}
        <aside aria-label="Sacola" className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-rule bg-surface">
          <h2 className="m-0 border-b border-rule px-4 py-3 font-heading text-title font-semibold">Sua sacola</h2>
          <div className="min-h-0 flex-1 overflow-y-auto">{panel}</div>
        </aside>
      </div>

      {lines.length > 0 && !open && (
        <div className="fixed inset-x-0 bottom-[60px] z-40 border-t border-rule bg-surface p-3 shadow-[0_-2px_10px_rgba(26,24,20,.06)] lg:hidden">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex h-12 w-full items-center justify-between rounded-lg bg-(--menu-accent) px-4 font-semibold text-white tabular-nums"
          >
            <span>{summary}</span>
            <span>Ver sacola</span>
          </button>
        </div>
      )}

      {open && (
        <Sheet title="Sua sacola" onClose={() => setOpen(false)}>
          {panel}
        </Sheet>
      )}
      {editing && editingItem && (
        <ItemSheet slug={slug} item={editingItem} category={visible.find((c) => c.id === editingItem.categoryId)} editing={editing} onClose={() => setEditing(null)} />
      )}
      {adding && <ItemSheet slug={slug} item={adding} category={visible.find((c) => c.id === adding.categoryId)} onClose={() => setAdding(null)} />}
    </>
  );
}

function BagPanel({
  slug,
  store,
  categories,
  highlights,
  items,
  checks,
  onEdit,
  onSuggest,
  button,
}: {
  slug: string;
  store: BagStore;
  categories: PublicMenuCategory[];
  highlights: PublicMenuItem[];
  items: Map<string, PublicMenuItem>;
  checks: Record<string, LineCheck>;
  onEdit: (line: CartLine) => void;
  onSuggest: (item: PublicMenuItem) => void;
  button: ReturnType<typeof bagButton>;
}) {
  const cart = useCart();
  const router = useRouter();
  const { lines } = cart;
  const subtotal = subtotalOf(lines);
  const remaining = freeDeliveryRemaining(subtotal, store.freeDeliveryFromCents);
  const suggestions = suggestionsOf(categories, highlights, lines, remaining);
  const couponId = useSelectedCoupon(slug);
  const coupons = useCoupons(slug, subtotal);
  const coupon = coupons?.coupons.find((c) => c.id === couponId && c.available) ?? null;
  const effect = couponEffect(coupon, subtotal);

  if (lines.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="text-ink-3" aria-hidden="true">
          <path d="M5 8h14l-1 12H6L5 8zM9 8V6a3 3 0 016 0v2" />
        </svg>
        <div className="font-heading text-title font-semibold">Sua sacola está vazia</div>
        <div className="text-ink-2">Escolha um item do cardápio para começar o pedido.</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {remaining != null && (
        <div className="border-b border-rule px-4 py-3">
          <div className="mb-1.5 text-[12px] font-medium tabular-nums">
            {remaining > 0 ? `Faltam ${money(remaining)} para entrega grátis` : "Você ganhou entrega grátis"}
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(freeDeliveryProgress(subtotal, store.freeDeliveryFromCents) * 100)}
          >
            <div className="h-full rounded-full bg-success transition-[width]" style={{ width: `${freeDeliveryProgress(subtotal, store.freeDeliveryFromCents) * 100}%` }} />
          </div>
        </div>
      )}

      <ul className="m-0 list-none divide-y divide-rule p-0">
        {lines.map((line) => (
          <BagLine key={line.id} line={line} check={checks[line.id]} gone={lineGone(line, items)} onEdit={() => onEdit(line)} />
        ))}
      </ul>

      {suggestions.length > 0 && (
        <section className="border-t border-rule px-4 py-3" aria-label="Peça também">
          <h3 className="m-0 mb-2 text-[12px] font-semibold text-ink-2">Peça também</h3>
          <div className="-mr-4 flex gap-2 overflow-x-auto pr-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {suggestions.map(({ item, completes }) => (
              <button key={item.id} type="button" onClick={() => onSuggest(item)} className="flex w-30 shrink-0 flex-col gap-1 text-left">
                <span className="block h-20 w-full overflow-hidden rounded-lg bg-[#E9E3D9]">
                  {item.photoUrl && (
                    // eslint-disable-next-line @next/next/no-img-element -- ver ItemCard.
                    <img src={item.photoUrl} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
                  )}
                </span>
                <span className="text-[12px] font-medium">{item.name}</span>
                <span className="text-[12px] text-ink-2 tabular-nums">{money(referenceCents(item)!)}</span>
                {completes && <span className="text-[11px] font-medium text-success">Completa a entrega grátis</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      <Coupon slug={slug} subtotal={subtotal} />

      <dl className="m-0 flex flex-col gap-1 border-t border-rule px-4 py-3 tabular-nums">
        <Row label="Subtotal" value={money(subtotal)} />
        {coupon && effect.discountCents > 0 && <Row label={`Cupom ${coupon.title}`} value={`− ${money(effect.discountCents)}`} />}
        <Row label="Entrega" value={effect.freeDelivery ? "Grátis" : deliveryLine(store, subtotal)} />
        <Row label="Total" value={money(subtotal - effect.discountCents)} strong />
        {deliveryLine(store, subtotal) !== "Grátis" && <p className="m-0 text-[12px] text-ink-3">A entrega entra no total quando você informar o endereço.</p>}
      </dl>

      <div className="flex flex-col gap-2 px-4 pb-4">
        {button.message && (
          <p className={cn("m-0 text-[12px]", button.disabled ? "text-warning" : "text-ink-2")} role="status">
            {button.message}
          </p>
        )}
        {button.action && (
          <Button
            variant="accent"
            size="lg"
            className="w-full"
            disabled={button.disabled}
            onClick={async () => {
              router.push(`/c/${encodeURIComponent(slug)}/checkout${button.action === "schedule" ? "?agendar=1" : ""}`);
              // Segura o botão até a navegação sair da tela: sem segundo clique.
              await new Promise((resolve) => setTimeout(resolve, 4000));
            }}
          >
            {button.label}
          </Button>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between", strong && "pt-1 text-[15px] font-semibold")}>
      <dt className={strong ? "" : "text-ink-2"}>{label}</dt>
      <dd className="m-0">{value}</dd>
    </div>
  );
}

function BagLine({ line, check, gone, onEdit }: { line: CartLine; check: LineCheck | undefined; gone: boolean; onEdit: () => void }) {
  const cart = useCart();
  const bad = check?.kind === "unavailable" || gone;
  const details = [line.sizeName, line.half ? `meio a meio com ${line.half.name}` : null, ...line.optionLines.map((o) => o.name)].filter(Boolean).join(" · ");
  const setQuantity = (quantity: number) => {
    const unit = line.unitCents;
    cart.update({ ...line, quantity, totalCents: unit * quantity });
  };
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{line.name}</div>
          {details && <div className="text-[12px] text-ink-2">{details}</div>}
          {line.note && <div className="text-[12px] text-ink-3">Obs.: {line.note}</div>}
        </div>
        <div className="font-medium whitespace-nowrap tabular-nums">{money(line.totalCents)}</div>
      </div>
      {check?.kind === "changed" && (
        <div className="rounded-md bg-[#FEF9EC] px-2.5 py-1.5 text-[12px] text-[#7A5008]" role="status">
          O preço mudou de {money(check.fromCents)} para {money(check.toCents)}
        </div>
      )}
      {bad && (
        <div className="rounded-md bg-tomate-lt px-2.5 py-1.5 text-[12px] text-tomate" role="alert">
          {check?.kind === "unavailable" ? check.message : "Esgotou ou saiu do cardápio"}
        </div>
      )}
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          <Button variant="ghost" size="xs" onClick={onEdit}>
            {bad ? "Trocar" : "Editar"}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => cart.remove(line.id)}>
            Remover
          </Button>
        </div>
        {!bad && (
          <div className="flex items-center gap-1 tabular-nums">
            <Button variant="outline" size="icon-xs" aria-label="Diminuir" disabled={line.quantity <= 1} onClick={() => setQuantity(line.quantity - 1)}>
              <MinusIcon />
            </Button>
            <span className="w-6 text-center font-medium">{line.quantity}</span>
            <Button variant="outline" size="icon-xs" aria-label="Aumentar" disabled={line.quantity >= MAX_QUANTITY} onClick={() => setQuantity(line.quantity + 1)}>
              <PlusIcon />
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Cupons do cliente (tags positivas): quem entrou com o código escolhe um, e o desconto entra nos totais; o servidor
 * confere de novo no pedido. Sem o código, o convite para entrar (o cupom fica atrás do código, não do telefone).
 */
function Coupon({ slug, subtotal }: { slug: string; subtotal: number }) {
  const data = useCoupons(slug, subtotal);
  const selected = useSelectedCoupon(slug);
  if (data === undefined) return null;
  if (data === null) {
    return (
      <a href={`/c/${encodeURIComponent(slug)}/conta?voltar=1`} className="flex items-center gap-2 border-t border-rule px-4 py-3 text-[13px] font-medium text-ink no-underline">
        <TicketPercentIcon className="size-4 text-(--menu-accent)" aria-hidden />
        <span className="flex-1">Entre para usar seus cupons</span>
        <ChevronRightIcon className="size-4 text-ink-2" aria-hidden />
      </a>
    );
  }
  if (data.coupons.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t border-rule px-4 py-3">
      <span className="text-[12px] font-semibold text-ink-2">Seus cupons (vale um por pedido)</span>
      {data.coupons.map((coupon) => {
        const active = selected === coupon.id;
        return (
          <div key={coupon.id} className={cn("flex items-center gap-2 rounded-lg border px-3 py-2", active ? "border-(--menu-accent) bg-(--menu-accent)/5" : "border-dashed border-rule")}>
            <span className="flex-1 text-[13px]">
              <span className="font-semibold">{coupon.title}</span> · {couponSummary(coupon, money)}
              {!coupon.available && coupon.reason && <span className="block text-[12px] text-ink-3">{coupon.reason}</span>}
            </span>
            {coupon.available && (
              <button type="button" onClick={() => selectCoupon(slug, active ? null : coupon.id)} className="h-9 rounded-md border border-rule bg-surface px-3 text-[13px] font-semibold">
                {active ? "Remover" : "Usar"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
