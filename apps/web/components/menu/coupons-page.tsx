"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { BLOCK, ErrorNote, FilterChip, Headline, loadError, MenuPage, PageHeader, SELECT_CLASS, StatusBadge, Toggle } from "@/components/menu/bits";
import { useMenu, useMenuActions, useTenantId } from "@/components/menu/use-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { centsText, type MenuTree, money, parseCents } from "@/lib/menu";
import { type Coupon, type CouponKind, couponStatusView, discountText, longDate, minuteText, plural, shortDate, validityText, WEEK_ORDER, WEEKDAY_SHORT } from "@/lib/menu-backstage";
import { cn } from "@/lib/utils";

type Filter = "all" | "AVAILABLE" | "OUT_OF_HOURS" | "EXPIRED" | "INACTIVE";
const FILTER_LABEL: Record<Filter, string> = { all: "Todos", AVAILABLE: "Disponível", OUT_OF_HOURS: "Fora do horário", EXPIRED: "Expirado", INACTIVE: "Inativo" };
const PAYMENT_LABEL = { pix: "Pix", card: "Cartão na entrega", cash: "Dinheiro" } as const;
type Payment = keyof typeof PAYMENT_LABEL;

function useCoupons() {
  const { request } = useAuth();
  const tenantId = useTenantId();
  return useQuery({ queryKey: ["menu-coupons", tenantId], queryFn: () => request<Coupon[]>(`/menu/${tenantId}/coupons`), enabled: Boolean(tenantId), retry: false });
}

/** N4: cupons por código ou automáticos, com dia, horário e regras; o editor fica embaixo da lista. */
export function CouponsPage() {
  const coupons = useCoupons();
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const header = (
    <PageHeader title="Cupons" description="Descontos por código ou automáticos, com dia, horário e regras.">
      <Button onClick={() => setSelected("new")}>
        <PlusIcon aria-hidden /> Novo cupom
      </Button>
    </PageHeader>
  );

  if (coupons.isPending) {
    return (
      <MenuPage>
        {header}
        <div className={cn(BLOCK, "p-8 text-center text-ink-3")} aria-busy>
          Carregando os cupons…
        </div>
      </MenuPage>
    );
  }
  if (coupons.isError) {
    const failure = loadError(coupons.error);
    return (
      <MenuPage>
        {header}
        <ErrorNote action={!failure.forbidden && <Button size="sm" variant="outline" onClick={() => coupons.refetch()}>Tentar de novo</Button>}>
          {failure.forbidden ? failure.text : "Não foi possível carregar os cupons. Os cupons que já valem continuam valendo no cardápio."}
        </ErrorNote>
      </MenuPage>
    );
  }

  const all = coupons.data;
  const count = (kind: Filter) => all.filter((c) => c.status.kind === kind).length;
  const shown = all.filter((c) => filter === "all" || c.status.kind === filter);
  const editing = selected === "new" ? null : (all.find((c) => c.id === selected) ?? null);
  const totalDiscounted = all.reduce((s, c) => s + c.discountedCents, 0);
  const totalUses = all.reduce((s, c) => s + c.uses, 0);

  return (
    <MenuPage>
      {header}
      {all.length === 0 && selected !== "new" ? (
        <section className={cn(BLOCK, "flex flex-col items-center gap-3 px-6 py-12 text-center")}>
          <p className="font-heading text-[22px] font-bold">Nenhum cupom ainda · 0 cupons</p>
          <p className="max-w-[520px] text-ink-2">Crie um cupom com código para divulgar, ou sem código para entrar sozinho no carrinho (como o desconto da primeira compra).</p>
          <Button onClick={() => setSelected("new")}>
            <PlusIcon aria-hidden /> Novo cupom
          </Button>
        </section>
      ) : (
        <section className={BLOCK}>
          <Headline value={`${plural(count("AVAILABLE"), "cupom disponível", "cupons disponíveis")} agora`} sub={`${money(totalDiscounted)} descontados no total · ${plural(totalUses, "uso", "usos")}`}>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrar por situação">
              {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
                <FilterChip key={f} active={filter === f} onClick={() => setFilter(f)}>
                  {FILTER_LABEL[f]} {f === "all" ? all.length : count(f)}
                </FilterChip>
              ))}
            </div>
          </Headline>
          <table className="w-full border-t border-rule text-[13px]">
            <thead className="text-[12px] text-ink-3">
              <tr className="border-b border-rule">
                <th className="py-2.5 pl-4 text-left font-medium">Situação</th>
                <th className="text-left font-medium">Nome</th>
                <th className="text-left font-medium">Código</th>
                <th className="text-left font-medium">Desconto</th>
                <th className="text-left font-medium">Validade</th>
                <th className="text-right font-medium">Usos</th>
                <th className="pr-4 text-right font-medium">Descontado</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const view = couponStatusView(c.status);
                const off = c.status.kind === "EXPIRED" || c.status.kind === "INACTIVE";
                return (
                  <tr
                    key={c.id}
                    onClick={() => setSelected(c.id)}
                    className={cn("cursor-pointer border-b border-rule-soft last:border-0 hover:bg-paper", editing?.id === c.id && "border-l-[3px] border-l-ink bg-surface-2")}
                  >
                    <td className="py-2.5 pl-4">
                      <StatusBadge tone={view.tone}>{view.label}</StatusBadge>
                      {view.sub && <div className="mt-0.5 text-[11.5px] text-ink-3">{view.sub}</div>}
                    </td>
                    <td className={cn("font-semibold", off && "font-normal text-ink-2")}>
                      <button type="button" className="text-left hover:underline" onClick={() => setSelected(c.id)}>
                        {c.name}
                      </button>
                    </td>
                    <td>
                      {c.code ? (
                        <span className={cn("font-semibold tracking-wide", c.status.kind === "EXPIRED" && "line-through")}>{c.code}</span>
                      ) : (
                        <span className="rounded-sm border border-dashed border-tag-line px-1.5 py-0.5 text-[12px] text-ink-2">Automático · sem código</span>
                      )}
                    </td>
                    <td>{discountText(c)}</td>
                    <td className="max-w-56">{c.status.kind === "INACTIVE" && !c.endsOn && !c.weekdays.length ? "—" : validityText(c)}</td>
                    <td className="text-right tabular-nums">{c.usageLimit ? `${c.uses} de ${c.usageLimit}` : c.uses}</td>
                    <td className="pr-4 text-right font-semibold tabular-nums">{money(c.discountedCents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      {(selected === "new" || editing) && <CouponEditor key={editing?.id ?? "new"} coupon={editing} onClose={() => setSelected(null)} onSaved={(id) => setSelected(id)} />}
    </MenuPage>
  );
}

type Form = {
  name: string;
  code: string;
  active: boolean;
  kind: CouponKind;
  value: string;
  percent: string;
  maxDiscount: string;
  startsOn: string;
  endsOn: string;
  weekdays: number[];
  start: string;
  end: string;
  delivery: boolean;
  pickup: boolean;
  usageLimit: string;
  minOrder: string;
  newCustomersOnly: boolean;
  oncePerCustomer: boolean;
  paymentMethods: Payment[];
  categoryIds: string[];
  itemIds: string[];
};

const toHHMM = (m: number | null) => (m == null ? "" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
const fromHHMM = (t: string) => (/^\d{2}:\d{2}$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);

function formOf(c: Coupon | null): Form {
  return {
    name: c?.name ?? "",
    code: c?.code ?? "",
    active: c?.active ?? true,
    kind: c?.kind ?? "PERCENT",
    value: centsText(c?.kind === "FIXED" ? c.valueCents : null),
    percent: c?.kind === "PERCENT" ? String(c.percent) : "",
    maxDiscount: centsText(c?.maxDiscountCents),
    startsOn: c?.startsOn ?? "",
    endsOn: c?.endsOn ?? "",
    weekdays: c?.weekdays ?? [],
    start: toHHMM(c?.startMinute ?? null),
    end: toHHMM(c?.endMinute ?? null),
    delivery: c?.delivery ?? true,
    pickup: c?.pickup ?? true,
    usageLimit: c?.usageLimit ? String(c.usageLimit) : "",
    minOrder: c?.minOrderCents ? centsText(c.minOrderCents) : "",
    newCustomersOnly: c?.newCustomersOnly ?? false,
    oncePerCustomer: c?.oncePerCustomer ?? false,
    paymentMethods: c?.paymentMethods ?? [],
    categoryIds: c?.categoryIds ?? [],
    itemIds: c?.itemIds ?? [],
  };
}

/** O corpo da API, ou a mensagem do primeiro campo inválido. */
function bodyOf(f: Form): { ok: true; body: object } | { ok: false; error: string } {
  if (!f.name.trim()) return { ok: false, error: "Dê um nome ao cupom (só a equipe vê)." };
  const value = parseCents(f.value);
  const percent = Number(f.percent);
  if (f.kind === "FIXED" && !value) return { ok: false, error: "Informe o valor do desconto em R$." };
  if (f.kind === "PERCENT" && !(Number.isInteger(percent) && percent >= 1 && percent <= 100)) return { ok: false, error: "Informe a porcentagem do desconto, de 1 a 100." };
  const maxDiscount = f.maxDiscount.trim() ? parseCents(f.maxDiscount) : null;
  if (f.maxDiscount.trim() && maxDiscount === null) return { ok: false, error: "Desconto máximo: informe um valor em R$." };
  const minOrder = f.minOrder.trim() ? parseCents(f.minOrder) : 0;
  if (minOrder === null) return { ok: false, error: "Pedido mínimo: informe um valor em R$." };
  const usageLimit = f.usageLimit.trim() ? Number(f.usageLimit) : null;
  if (usageLimit !== null && !(Number.isInteger(usageLimit) && usageLimit > 0)) return { ok: false, error: "Quantidade de usos: informe um número inteiro." };
  const startMinute = fromHHMM(f.start);
  const endMinute = fromHHMM(f.end);
  if ((startMinute == null) !== (endMinute == null)) return { ok: false, error: "Horário: informe o início e o fim, ou deixe os dois vazios." };
  if (!f.delivery && !f.pickup) return { ok: false, error: "Escolha entrega, retirada ou as duas." };
  return {
    ok: true,
    body: {
      name: f.name.trim(),
      code: f.code.trim() || null,
      active: f.active,
      kind: f.kind,
      valueCents: f.kind === "FIXED" ? value : undefined,
      percent: f.kind === "PERCENT" ? percent : undefined,
      maxDiscountCents: f.kind === "PERCENT" ? maxDiscount : null,
      startsOn: f.startsOn || null,
      endsOn: f.endsOn || null,
      weekdays: f.weekdays,
      startMinute,
      endMinute,
      delivery: f.delivery,
      pickup: f.pickup,
      usageLimit,
      minOrderCents: minOrder,
      newCustomersOnly: f.newCustomersOnly,
      oncePerCustomer: f.oncePerCustomer,
      paymentMethods: f.paymentMethods,
      categoryIds: f.categoryIds,
      itemIds: f.itemIds,
    },
  };
}

/** "10% em pizzas, de seg a qui, das 18h às 20h, a partir de R$ 50." */
function ruleSentence(f: Form, tree: MenuTree | undefined): string {
  const scope = [
    ...f.categoryIds.map((id) => tree?.categories.find((c) => c.id === id)?.name.toLowerCase()),
    ...f.itemIds.map((id) => tree?.categories.flatMap((c) => c.items).find((i) => i.id === id)?.name),
  ].filter(Boolean);
  const main = f.kind === "FREE_DELIVERY" ? "Entrega grátis" : f.kind === "FIXED" ? `${money(parseCents(f.value) ?? 0)} de desconto` : `${f.percent || "0"}%`;
  const parts = [scope.length ? `${main} em ${scope.join(", ")}` : main];
  const days = [...f.weekdays].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b));
  if (days.length && days.length < 7) {
    const contiguous = days.length > 2 && days.every((d, i) => i === 0 || WEEK_ORDER.indexOf(d) === WEEK_ORDER.indexOf(days[i - 1]!) + 1);
    parts.push(contiguous ? `de ${WEEKDAY_SHORT[days[0]!]!.toLowerCase()} a ${WEEKDAY_SHORT[days.at(-1)!]!.toLowerCase()}` : days.map((d) => WEEKDAY_SHORT[d]!.toLowerCase()).join(", "));
  }
  const s = fromHHMM(f.start);
  const e = fromHHMM(f.end);
  if (s != null && e != null) parts.push(`das ${minuteText(s)} às ${minuteText(e)}`);
  const min = parseCents(f.minOrder);
  if (min) parts.push(`a partir de ${money(min).replace(",00", "")}`);
  return `${parts.join(", ")}.`;
}

function ruleDetails(f: Form): string {
  const max = parseCents(f.maxDiscount);
  const payments = f.paymentMethods.length ? f.paymentMethods.map((p) => PAYMENT_LABEL[p].replace("Cartão na entrega", "cartão na entrega")).join(" ou ") : null;
  return [
    f.kind === "PERCENT" && max ? `Até ${money(max)} por pedido` : null,
    f.oncePerCustomer ? "1 uso por cliente" : null,
    f.newCustomersOnly ? "só novos clientes" : null,
    f.delivery && f.pickup ? "entrega e retirada" : f.delivery ? "só entrega" : "só retirada",
    payments,
    f.endsOn ? `até ${longDate(f.endsOn)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function CouponEditor({ coupon, onClose, onSaved }: { coupon: Coupon | null; onClose: () => void; onSaved: (id: string) => void }) {
  const menu = useMenu();
  const { call, error } = useMenuActions();
  const toast = useToast();
  const [form, setForm] = useState<Form>(() => formOf(coupon));
  const [problem, setProblem] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(Boolean(coupon && (coupon.paymentMethods.length || coupon.categoryIds.length || coupon.itemIds.length)));
  const [pickItems, setPickItems] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const tree = menu.data;
  const categories = tree?.categories ?? [];
  const items = categories.flatMap((c) => c.items);
  const advancedCount = [form.paymentMethods.length > 0, form.categoryIds.length > 0 || form.itemIds.length > 0].filter(Boolean).length;
  const view = coupon ? couponStatusView(coupon.status) : null;

  const save = async () => {
    setProblem(null);
    const result = bodyOf(form);
    if (!result.ok) return setProblem(result.error);
    const done = coupon ? await call<Coupon>(`/coupons/${coupon.id}`, "PATCH", result.body) : await call<Coupon>("/coupons", "POST", result.body);
    if (!done) return;
    toast(coupon ? "Cupom salvo." : "Cupom criado.");
    onSaved(done.data.id);
  };

  // Exemplo do carrinho: um item que entra no desconto e, se houver, um que não entra.
  const eligible = (id: string, categoryId: string) => (!form.categoryIds.length && !form.itemIds.length) || form.categoryIds.includes(categoryId) || form.itemIds.includes(id);
  const priced = items.filter((i) => i.priceCents != null || i.sizes.length);
  const unit = (i: (typeof items)[number]) => (i.sizes.length ? Math.max(...i.sizes.map((s) => s.priceCents)) : i.priceCents!);
  const inItem = priced.find((i) => eligible(i.id, i.categoryId));
  const outItem = priced.find((i) => !eligible(i.id, i.categoryId));
  const pct = Number(form.percent) || 0;
  const max = parseCents(form.maxDiscount);
  const exampleDiscount = !inItem ? 0 : form.kind === "PERCENT" ? Math.min(Math.round((unit(inItem) * pct) / 100), max ?? Infinity) : form.kind === "FIXED" ? Math.min(parseCents(form.value) ?? 0, unit(inItem)) : 0;

  return (
    <div className="flex flex-wrap items-start gap-4">
      <section className={cn(BLOCK, "min-w-0 flex-[999_1_560px]")} aria-label={coupon ? "Editar cupom" : "Novo cupom"}>
        <div className="flex items-center gap-3 border-b border-rule px-5 py-3.5">
          <h2 className="mr-auto font-heading text-title font-semibold">{coupon ? "Editar cupom" : "Novo cupom"}</h2>
          <span className="flex items-center gap-2 text-[13px]">
            <Toggle on={form.active} label="Ativo" onToggle={() => set("active", !form.active)} /> {form.active ? "Ativo" : "Inativo"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-4 border-b border-rule px-5 py-4">
          <Field label="Nome" hint="Só a equipe vê" id="c-name">
            <Input id="c-name" maxLength={80} value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Código" hint="Sem código, vale para todos e entra sozinho no carrinho." id="c-code">
            <Input id="c-code" maxLength={30} value={form.code} onChange={(e) => set("code", e.target.value.toUpperCase().replace(/\s+/g, ""))} placeholder="Automático" />
          </Field>
        </div>
        <Section title="Desconto">
          <div className="flex overflow-hidden rounded-lg border border-rule" role="group" aria-label="Tipo de desconto">
            {(["FIXED", "PERCENT", "FREE_DELIVERY"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={form.kind === k}
                onClick={() => set("kind", k)}
                className={cn("h-9 px-4 text-[13px]", form.kind === k ? "bg-ink font-semibold text-paper" : "bg-surface text-ink-2", k === "FREE_DELIVERY" && "flex-1 text-left")}
              >
                {k === "FIXED" ? "R$" : k === "PERCENT" ? "%" : "Entrega grátis"}
              </button>
            ))}
          </div>
          {form.kind !== "FREE_DELIVERY" && (
            <div className="grid grid-cols-2 gap-4">
              {form.kind === "FIXED" ? (
                <Field label="Valor" id="c-value">
                  <Input id="c-value" inputMode="decimal" placeholder="R$ 0,00" value={form.value} onChange={(e) => set("value", e.target.value)} />
                </Field>
              ) : (
                <Field label="Valor (%)" id="c-percent">
                  <Input id="c-percent" inputMode="numeric" placeholder="10" value={form.percent} onChange={(e) => set("percent", e.target.value.replace(/\D/g, "").slice(0, 3))} />
                </Field>
              )}
              {form.kind === "PERCENT" && (
                <Field label="Desconto máximo por pedido" hint="Opcional" id="c-max">
                  <Input id="c-max" inputMode="decimal" placeholder="R$ 0,00" value={form.maxDiscount} onChange={(e) => set("maxDiscount", e.target.value)} />
                </Field>
              )}
            </div>
          )}
        </Section>
        <Section title="Quando vale">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Começa em" id="c-start-day">
              <Input id="c-start-day" type="date" value={form.startsOn} onChange={(e) => set("startsOn", e.target.value)} />
            </Field>
            <Field label="Termina em" hint="Vazio = sem data para acabar" id="c-end-day">
              <Input id="c-end-day" type="date" value={form.endsOn} min={form.startsOn || undefined} onChange={(e) => set("endsOn", e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">Dias da semana</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Dias da semana">
              {WEEK_ORDER.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={form.weekdays.includes(d)}
                  onClick={() => set("weekdays", toggle(form.weekdays, d))}
                  className={cn("h-9 min-w-11 rounded-md border px-2 text-[13px]", form.weekdays.includes(d) ? "border-ink bg-ink font-semibold text-paper" : "border-rule bg-surface text-ink-2")}
                >
                  {WEEKDAY_SHORT[d]}
                </button>
              ))}
            </div>
            <span className="text-[12px] text-ink-3">Nenhum marcado = todos os dias.</span>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Das" id="c-from">
              <Input id="c-from" type="time" className="w-28" value={form.start} onChange={(e) => set("start", e.target.value)} />
            </Field>
            <Field label="Até" id="c-to">
              <Input id="c-to" type="time" className="w-28" value={form.end} onChange={(e) => set("end", e.target.value)} />
            </Field>
            <p className="max-w-[360px] pb-2 text-[12px] text-ink-3">
              {fromHHMM(form.start) != null && fromHHMM(form.end) != null
                ? `Fora desse horário, o cliente vê "Cupom disponível ${ruleSentence({ ...form, categoryIds: [], itemIds: [], minOrder: "" }, tree).replace(/^[^,]*, /, "").replace(/\.$/, "")}".`
                : "Sem horário: vale o dia todo."}
            </p>
          </div>
        </Section>
        <Section title="Para quem e para quais pedidos">
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-[13px] font-medium">Tipo de pedido</span>
            <Check label="Entrega" checked={form.delivery} onChange={(v) => set("delivery", v)} />
            <Check label="Retirada" checked={form.pickup} onChange={(v) => set("pickup", v)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Quantidade de usos" hint={coupon ? `${coupon.uses} já usados${coupon.usageLimit ? ` · ${Math.max(0, coupon.usageLimit - coupon.uses)} restantes` : ""}` : "Vazio = sem limite"} id="c-limit">
              <Input id="c-limit" inputMode="numeric" value={form.usageLimit} onChange={(e) => set("usageLimit", e.target.value.replace(/\D/g, ""))} placeholder="Sem limite" />
            </Field>
            <Field label="Pedido mínimo" hint="Antes da taxa de entrega" id="c-min">
              <Input id="c-min" inputMode="decimal" placeholder="R$ 0,00" value={form.minOrder} onChange={(e) => set("minOrder", e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-6">
            <span className="flex items-center gap-2.5 text-[13px]">
              <Toggle on={form.newCustomersOnly} label="Só para novos clientes" onToggle={() => set("newCustomersOnly", !form.newCustomersOnly)} /> Só para novos clientes
            </span>
            <span className="flex items-center gap-2.5 text-[13px]">
              <Toggle on={form.oncePerCustomer} label="Um uso por cliente" onToggle={() => set("oncePerCustomer", !form.oncePerCustomer)} /> Um uso por cliente
            </span>
          </div>
          {(form.newCustomersOnly || form.oncePerCustomer) && (
            <p className="text-[12px] text-ink-3">Para conferir quem é o cliente, o cupom só vale para quem entrou no cardápio com o código do WhatsApp.</p>
          )}
        </Section>
        <div className="border-b border-rule px-5 py-3">
          <button type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)} className="flex items-center gap-1.5 text-[13px] font-semibold">
            <ChevronDownIcon className={cn("size-4 transition-transform", !advanced && "-rotate-90")} aria-hidden /> Avançado
            <span className="font-normal text-ink-3">· {plural(advancedCount, "regra", "regras")}</span>
          </button>
          {advanced && (
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-4">
                <span className="text-[13px] font-medium">Formas de pagamento</span>
                {(Object.keys(PAYMENT_LABEL) as Payment[]).map((p) => (
                  <Check key={p} label={PAYMENT_LABEL[p]} checked={form.paymentMethods.includes(p)} onChange={() => set("paymentMethods", toggle(form.paymentMethods, p))} />
                ))}
              </div>
              <span className="-mt-2 text-[12px] text-ink-3">Nenhuma marcada = qualquer forma de pagamento.</span>
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">Categorias</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {form.categoryIds.map((id) => (
                    <span key={id} className="inline-flex items-center gap-1 rounded-sm border border-dashed border-tag-line px-2 py-0.5 text-[12px]">
                      {categories.find((c) => c.id === id)?.name ?? "Categoria apagada"}
                      <button type="button" aria-label="Tirar a categoria" onClick={() => set("categoryIds", form.categoryIds.filter((c) => c !== id))}>
                        <XIcon className="size-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                  <select
                    aria-label="Adicionar categoria"
                    className={cn(SELECT_CLASS, "h-7 w-auto border-dashed text-[12px]")}
                    value=""
                    onChange={(e) => e.target.value && set("categoryIds", [...form.categoryIds, e.target.value])}
                  >
                    <option value="">+ Categoria</option>
                    {categories
                      .filter((c) => !form.categoryIds.includes(c.id))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium">Itens</span>
                <span className="text-[13px] text-ink-2">
                  {form.itemIds.length
                    ? form.itemIds.map((id) => items.find((i) => i.id === id)?.name ?? "Item apagado").join(", ")
                    : form.categoryIds.length
                      ? "Todos os itens das categorias escolhidas"
                      : "Todos os itens do cardápio"}
                </span>
                <button type="button" className="self-start text-[13px] font-medium underline" onClick={() => setPickItems(!pickItems)}>
                  {pickItems ? "Fechar a lista" : "Escolher itens"}
                </button>
                {pickItems && (
                  <div className="grid max-h-56 grid-cols-2 gap-x-4 gap-y-1 overflow-y-auto rounded-lg border border-rule p-3">
                    {items.map((i) => (
                      <Check key={i.id} label={i.name} checked={form.itemIds.includes(i.id)} onChange={() => set("itemIds", toggle(form.itemIds, i.id))} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        {(problem || error) && (
          <div className="px-5 pt-3">
            <ErrorNote>{problem ?? error}</ErrorNote>
          </div>
        )}
        <div className="flex items-center gap-2 px-5 py-3">
          {coupon && (
            <Button
              variant="ghost"
              className="mr-auto text-tomate"
              onClick={async () => {
                if (await call(`/coupons/${coupon.id}`, "DELETE")) {
                  toast("Cupom excluído.");
                  onClose();
                }
              }}
            >
              <Trash2Icon aria-hidden /> Excluir cupom
            </Button>
          )}
          <Button variant="outline" className={coupon ? "" : "ml-auto"} onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={save}>Salvar</Button>
        </div>
      </section>

      <aside className="flex w-[300px] shrink-0 flex-col gap-3">
        <div className={cn(BLOCK, "border-ink px-4 py-4")}>
          <p className="text-[12px] text-ink-3">Resumo da regra</p>
          <p className="mt-1.5 font-heading text-[20px] leading-snug font-bold">{ruleSentence(form, tree)}</p>
          <p className="mt-2 text-[12.5px] text-ink-2">{ruleDetails(form)}.</p>
          {view && coupon && (
            <div className="mt-3 flex items-center gap-2 border-t border-rule pt-3 text-[12.5px] text-ink-2">
              <StatusBadge tone={view.tone}>{view.label}</StatusBadge> {view.sub ?? ""}
            </div>
          )}
        </div>
        {form.kind !== "FREE_DELIVERY" && inItem && (
          <div className={cn(BLOCK, "px-4 py-4")}>
            <p className="text-[12px] text-ink-3">Como o cliente vê no carrinho</p>
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-dashed border-success bg-success-lt px-3 py-2.5 text-success-ink">
              <CheckIcon className="size-4 shrink-0" aria-hidden />
              <span className="flex-1 text-[13px] font-semibold">{form.code || form.name || "Cupom"} aplicado</span>
              <span className="font-semibold tabular-nums">−{money(exampleDiscount)}</span>
            </div>
            <p className="mt-2 text-[12px] text-ink-3">
              Exemplo: 1 {inItem.name} ({money(unit(inItem))}){outItem ? ` e 1 ${outItem.name}. O desconto não vale para ${outItem.name}.` : "."}
            </p>
          </div>
        )}
        {coupon && (
          <div className={cn(BLOCK, "px-4 py-4")}>
            <p className="text-[12px] text-ink-3">Desde {shortDate(coupon.createdAt.slice(0, 10))}</p>
            <p className="mt-1 text-[15px] font-semibold">
              {plural(coupon.uses, "uso", "usos")} · {money(coupon.discountedCents)} descontados
            </p>
            <Link href="/cardapio/relatorio" className="text-[13px] underline">
              Ver no relatório de vendas
            </Link>
          </div>
        )}
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-rule px-5 py-4">
      <p className="text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">{title}</p>
      {children}
    </div>
  );
}

function Field({ label, hint, id, children }: { label: string; hint?: string; id: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <span className="text-[12px] text-ink-3">{hint}</span>}
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <input type="checkbox" className="size-4 accent-ink" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
