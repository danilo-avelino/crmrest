// Pagamento, revisão e envio do pedido do cardápio público (F3-08, F6-07; W11 a W13 e W15). Funções puras e chamadas da
// API, sem React, para testar sozinho. O preço é sempre o do servidor: o envio leva o total que o cliente viu em cada
// linha, e a API devolve PRICE_CHANGED quando mudou. A chave de idempotência fica guardada até o pedido entrar, para o
// "Tentar de novo" (falha de rede) nunca criar outro pedido.

import { isValidCpf } from "@dishdesk/shared";
import { priceRequestOf } from "./item-sheet";
import { type CartLine, selectionOfLine } from "./public-cart";
import { arrivalWindow, type CheckoutState, etaLabel, type Slot } from "./public-checkout";
import { money } from "./public-menu";

// ---------- Pagamento (W11) ----------

export type PayLater = "cash" | "credit" | "debit" | "pix_on_delivery";
/** Pix online (F6): pago na hora, pela Pagar.me, antes de o pedido nascer. */
export type PayMethod = PayLater | "pix";
export type PaymentChoice = {
  method: PayMethod | null;
  /** Só no dinheiro: null enquanto o cliente não respondeu "Precisa de troco?". */
  needsChange: boolean | null;
  /** Como o cliente digitou ("100,00"). */
  changeFor: string;
  /** Só no Pix online: CPF como o cliente digitou (a Pagar.me exige). */
  cpf?: string;
};

export const EMPTY_PAYMENT: PaymentChoice = { method: null, needsChange: null, changeFor: "", cpf: "" };

/** "52998224725" → "529.982.247-25", enquanto digita. */
export function formatCpf(input: string): string {
  const d = input.replace(/\D/g, "").slice(0, 11);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9)].filter(Boolean).join(".") + (d.length > 9 ? `-${d.slice(9)}` : "");
}

export const PAY_LATER: { id: PayLater; name: string; note: string }[] = [
  { id: "cash", name: "Dinheiro", note: "" },
  { id: "credit", name: "Cartão de crédito", note: "maquininha" },
  { id: "debit", name: "Cartão de débito", note: "maquininha" },
  { id: "pix_on_delivery", name: "Pix na maquininha", note: "maquininha" },
];

/** R15: o rótulo segue o modo do pedido. */
export const payLaterTitle = (mode: "DELIVERY" | "PICKUP" | null): string => (mode === "PICKUP" ? "Pagar na retirada" : "Pagar na entrega");

/** "100,00", "100", "R$ 1.234,5" → centavos; null quando não é um valor. */
export function parseMoney(input: string): number | null {
  const clean = input.replace(/[R$\s]/g, "").replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

export type PaymentErrors = { method?: string; change?: string; cpf?: string };
export type ValidPayment = { method: PayMethod; changeForCents: number | null; cpf?: string };
export type PaymentResult = ({ ok: true } & ValidPayment) | { ok: false; errors: PaymentErrors };

/** Validação do W11: uma forma escolhida; no dinheiro com troco, um valor maior que o total; no Pix, um CPF válido. */
export function validatePayment(choice: PaymentChoice, totalCents: number): PaymentResult {
  if (!choice.method) return { ok: false, errors: { method: "Escolha uma forma de pagamento" } };
  if (choice.method === "pix") {
    const cpf = (choice.cpf ?? "").replace(/\D/g, "");
    return isValidCpf(cpf) ? { ok: true, method: "pix", changeForCents: null, cpf } : { ok: false, errors: { cpf: "Informe um CPF válido para o Pix." } };
  }
  if (choice.method !== "cash") return { ok: true, method: choice.method, changeForCents: null };
  if (choice.needsChange === null) return { ok: false, errors: { change: "Diga se precisa de troco." } };
  if (!choice.needsChange) return { ok: true, method: "cash", changeForCents: null };
  const cents = parseMoney(choice.changeFor);
  if (cents === null) return { ok: false, errors: { change: "Informe o valor para o troco." } };
  if (cents <= totalCents) return { ok: false, errors: { change: `Precisa ser maior que o total de ${money(totalCents)}.` } };
  return { ok: true, method: "cash", changeForCents: cents };
}

/** Texto verde embaixo do valor: quanto volta de troco. */
export function changeHint(changeForCents: number, totalCents: number, mode: "DELIVERY" | "PICKUP" | null): string {
  const back = money(changeForCents - totalCents);
  return mode === "PICKUP" ? `Você recebe ${back} de troco.` : `O entregador leva ${back} de troco.`;
}

// ---------- Revisão (W12) ----------

export type ReviewModel = {
  whenLabel: string;
  whenValue: string;
  modeTitle: "Entrega" | "Retirada";
  addressLabel: string | null;
  addressLines: string[];
  payName: string;
  payDetail: string;
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  cta: string;
};

const PAY_NAME: Record<PayMethod, string> = { cash: "Dinheiro", credit: "Cartão de crédito", debit: "Cartão de débito", pix_on_delivery: "Pix na maquininha", pix: "Pix" };

/** Tudo o que o W12 mostra, a partir do estado do checkout, da sacola e do pagamento já validado. */
export function reviewModel(
  state: CheckoutState,
  lines: Pick<CartLine, "totalCents">[],
  payment: ValidPayment,
  store: { address: string | null; name: string },
  now: Date,
): ReviewModel {
  const subtotalCents = lines.reduce((sum, l) => sum + l.totalCents, 0);
  const deliveryFeeCents = state.mode === "DELIVERY" ? (state.quote?.feeCents ?? 0) : 0;
  const totalCents = subtotalCents + deliveryFeeCents;
  const pickup = state.mode === "PICKUP";
  const eta = state.quote?.eta ?? null;

  let when: { label: string; value: string };
  if (state.when?.kind === "scheduled") {
    const slot = state.when.slot;
    when = { label: `Agendado para ${slot.day === "today" ? "hoje" : "amanhã"}`, value: slot.label.replace("–", " – ") };
  } else if (eta) {
    when = pickup
      ? { label: `Fica pronto em ${etaLabel(eta)}`, value: `por volta das ${arrivalWindow({ minMinutes: eta.maxMinutes, maxMinutes: eta.maxMinutes }, now)}` }
      : { label: `Chega em ${etaLabel(eta)}`, value: arrivalWindow(eta, now) };
  } else {
    when = { label: pickup ? "Retirada" : "Entrega", value: "o quanto antes" };
  }

  let addressLabel: string | null = null;
  let addressLines: string[] = [];
  if (pickup) {
    addressLines = [store.address ?? store.name, "Retire na loja"];
  } else if (state.address?.kind === "saved") {
    addressLabel = state.address.title;
    addressLines = [state.address.area];
  } else if (state.address?.kind === "new") {
    const a = state.address.address;
    addressLabel = state.address.saveAs;
    addressLines = [[a.street, a.number || "s/n", a.complement].filter(Boolean).join(", "), [a.district, a.city].filter(Boolean).join(", ")];
  }
  const feeText = !pickup ? (deliveryFeeCents === 0 ? "entrega grátis" : `taxa ${money(deliveryFeeCents)}`) : null;
  if (feeText && addressLines.length) addressLines[addressLines.length - 1] = `${addressLines[addressLines.length - 1]} · ${feeText}`;

  const where = pickup ? "na retirada" : "na entrega";
  const pix = payment.method === "pix";
  const payDetail = pix
    ? "QR Code ou copia e cola na próxima tela"
    : payment.method === "cash"
      ? payment.changeForCents != null
        ? `Troco para ${money(payment.changeForCents)} · seu troco: ${money(payment.changeForCents - totalCents)}`
        : "Sem troco"
      : "Na maquininha";
  return {
    whenLabel: when.label,
    whenValue: when.value,
    modeTitle: pickup ? "Retirada" : "Entrega",
    addressLabel,
    addressLines,
    payName: pix ? "Pix agora" : `${PAY_NAME[payment.method]} ${where}`,
    payDetail,
    subtotalCents,
    deliveryFeeCents,
    totalCents,
    cta: pix ? `Pagar com Pix · ${money(totalCents)}` : `Fazer pedido · ${money(totalCents)}`,
  };
}

/** Corpo do POST /orders a partir do checkout, da sacola e do pagamento. */
export function orderRequestOf(input: {
  state: CheckoutState;
  lines: CartLine[];
  payment: ValidPayment;
  notes: string;
  idempotencyKey: string;
}): OrderRequest {
  const { state, lines, payment } = input;
  const identity = state.identity!;
  const address = state.address;
  const fulfillment: OrderRequest["fulfillment"] =
    state.mode === "PICKUP"
      ? { mode: "PICKUP" }
      : address?.kind === "saved"
        ? { mode: "DELIVERY", savedAddressId: address.id }
        : {
            mode: "DELIVERY",
            address: address && {
              street: address.address.street,
              number: address.address.noNumber ? "" : address.address.number,
              complement: address.address.complement || null,
              district: address.address.district,
              city: address.address.city,
              state: address.address.state,
              zipCode: address.address.zipCode || null,
              reference: address.address.reference || null,
            },
            lat: address?.lat ?? null,
            lng: address?.lng ?? null,
            saveAs: address?.saveAs ?? null,
          };
  return {
    idempotencyKey: input.idempotencyKey,
    lines: lines.map((line) => ({ lineId: line.id, ...priceRequestOf(selectionOfLine(line)), note: line.note, expectedTotalCents: line.totalCents })),
    fulfillment,
    when: state.when?.kind === "scheduled" ? { kind: "scheduled", start: state.when.slot.start } : { kind: "now" },
    payment: payment.method === "pix" ? { method: "pix", changeForCents: null, cpf: payment.cpf } : { method: payment.method, changeForCents: payment.changeForCents },
    customer: { name: identity.name, phone: identity.phone },
    notes: input.notes.trim() || null,
  };
}

export type OrderRequest = {
  idempotencyKey: string;
  /** Origem da visita e sessão anônima do navegador (F7-02): ligam o pedido ao funil. */
  sessionId?: string;
  attribution?: import("./attribution").Attribution;
  /** Cupom da tag escolhido (só com o código); null sem cupom. */
  couponId?: string | null;
  /** Link com contexto do WhatsApp (F3-11): fecha o carrinho da conversa. */
  contextToken?: string | null;
  lines: { lineId: string; itemId: string; sizeId?: string | null; optionIds?: string[]; halves?: string[]; quantity: number; note: string | null; expectedTotalCents: number }[];
  fulfillment:
    | { mode: "PICKUP" }
    | { mode: "DELIVERY"; savedAddressId: string }
    | {
        mode: "DELIVERY";
        address: { street: string; number: string; complement: string | null; district: string; city: string; state: string; zipCode: string | null; reference: string | null } | null;
        lat: number | null;
        lng: number | null;
        saveAs: string | null;
      };
  when: { kind: "now" } | { kind: "scheduled"; start: string };
  payment: { method: PayMethod; changeForCents: number | null; cpf?: string };
  customer: { name: string; phone: string };
  notes: string | null;
};

// ---------- Envio (W13) ----------

export type PriceChange = { lineId: string; name: string; fromCents: number; toCents: number };

export type PlaceOutcome =
  | { kind: "ok"; id: string; code: string; token: string }
  /** Pix gerado: o pedido só nasce quando a Pagar.me confirmar o pagamento. */
  | { kind: "pix"; pix: PendingPix }
  | { kind: "closed"; message: string; nextSlot: Slot | null; paused: boolean }
  | { kind: "slot"; message: string; nextSlot: Slot | null }
  | { kind: "soldOut"; message: string; lineIds: string[] }
  | { kind: "priceChanged"; message: string; changes: PriceChange[] }
  /** Erro que se corrige em outra tela: `fix` diz qual. */
  | { kind: "fix"; code: string; message: string; fix: "address" | "payment" | "bag" }
  | { kind: "network" };

const FIX: Record<string, "address" | "payment" | "bag"> = {
  OUT_OF_AREA: "address",
  ADDRESS_REQUIRED: "address",
  STORE_LOCATION_MISSING: "address",
  PICKUP_DISABLED: "address",
  PIX_UNAVAILABLE: "payment",
  PIX_FAILED: "payment",
  CPF_REQUIRED: "payment",
  PAYMENT_METHOD_UNAVAILABLE: "payment",
  CHANGE_TOO_LOW: "payment",
  MIN_ORDER: "bag",
  INVALID_LINE: "bag",
};

/** Resposta da API → o que a tela faz. Sem resposta (rede, 5xx) é "network": tentar de novo com a mesma chave. */
export function outcomeOf(status: number, body: unknown): PlaceOutcome {
  const json = (body ?? {}) as { code?: string; message?: unknown; nextSlot?: Slot | null; paused?: boolean; lines?: unknown[]; id?: string; token?: string };
  if (status === 200 && json.id && json.token) return { kind: "ok", id: json.id, code: String((json as { code?: unknown }).code ?? ""), token: json.token };
  const pix = json as Partial<PendingPix> & { kind?: string };
  if (status === 200 && pix.kind === "pix" && pix.paymentId && pix.token && pix.qrCode) {
    return { kind: "pix", pix: { paymentId: pix.paymentId, token: pix.token, qrCode: pix.qrCode, qrCodeUrl: pix.qrCodeUrl ?? null, expiresAt: pix.expiresAt ?? "", amountCents: pix.amountCents ?? 0 } };
  }
  // A Pagar.me falhou (502): a mensagem diz para tentar de novo ou pagar na entrega.
  if ((status >= 500 || status === 0) && json.code !== "PIX_FAILED") return { kind: "network" };
  const message = Array.isArray(json.message) ? String(json.message[0]) : typeof json.message === "string" ? json.message : "Não conseguimos fazer o pedido.";
  switch (json.code) {
    case "STORE_CLOSED":
      return { kind: "closed", message, nextSlot: json.nextSlot ?? null, paused: Boolean(json.paused) };
    case "SLOT_UNAVAILABLE":
      return { kind: "slot", message, nextSlot: json.nextSlot ?? null };
    case "ITEM_UNAVAILABLE":
      return { kind: "soldOut", message, lineIds: ((json.lines ?? []) as { lineId: string }[]).map((l) => l.lineId) };
    case "PRICE_CHANGED":
      return { kind: "priceChanged", message, changes: (json.lines ?? []) as PriceChange[] };
    default:
      return { kind: "fix", code: json.code ?? String(status), message, fix: FIX[json.code ?? ""] ?? (status === 400 ? "address" : "bag") };
  }
}

const base = (slug: string) => `/api/public/menu/${encodeURIComponent(slug)}`;

export async function placeOrder(slug: string, body: OrderRequest): Promise<PlaceOutcome> {
  try {
    const response = await fetch(`${base(slug)}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    const json = await response.json().catch(() => null);
    return outcomeOf(response.status, json);
  } catch {
    return { kind: "network" };
  }
}

export type PublicOrder = {
  id: string;
  code: string;
  status: string;
  placedAt: string;
  scheduledFor: string | null;
  mode: "DELIVERY" | "PICKUP";
  eta: { minMinutes: number; maxMinutes: number } | null;
  address: string | null;
  items: { name: string; quantity: number; totalCents: number; options: string[]; notes: string | null }[];
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  payment: { method: PayMethod; changeForCents: number | null };
  notes: string | null;
  storePhone: string | null;
  /** Vantagem aplicada (cupom ou presente da casa); ausente em API antiga. */
  benefit?: { label: string; discountCents: number; freeDelivery: boolean } | null;
  /** Etapas que já aconteceram, da mais antiga à mais nova (API nova). */
  timeline?: { code: string; at: string }[];
  /** Nota do cliente (1 a 5) ou null. */
  rating?: number | null;
  /** Escolhas para "Pedir de novo"; vazio em pedidos antigos. */
  reorder?: { itemId: string; sizeId: string | null; optionIds: string[]; halves: string[]; quantity: number; note: string | null }[];
};

/** Pedido para o W15; null quando o link não vale mais (sem sessão e sem o token deste navegador). */
export async function fetchOrder(slug: string, id: string, token: string | null): Promise<PublicOrder | null> {
  const response = await fetch(`${base(slug)}/orders/${encodeURIComponent(id)}`, {
    credentials: "same-origin",
    cache: "no-store",
    headers: token ? { "X-Order-Token": token } : {},
  });
  if (response.status === 401 || response.status === 404) return null;
  if (!response.ok) throw new Error(`Pedido indisponível (${response.status})`);
  return (await response.json()) as PublicOrder;
}

// ---------- Pix (W14) ----------

export type PendingPix = { paymentId: string; token: string; qrCode: string; qrCodeUrl: string | null; expiresAt: string; amountCents: number };
export type PixView = {
  status: "PENDING" | "PAID" | "EXPIRED" | "CANCELED" | "REFUNDED";
  amountCents: number;
  qrCode: string | null;
  qrCodeUrl: string | null;
  expiresAt: string | null;
  orderId: string | null;
  orderToken: string | null;
};

/** Situação do Pix; ainda pendente, a API confere na Pagar.me. null quando o link não vale (token de outro navegador). */
export async function fetchPix(slug: string, pix: Pick<PendingPix, "paymentId" | "token">): Promise<PixView | null> {
  const response = await fetch(`${base(slug)}/payments/${encodeURIComponent(pix.paymentId)}`, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { "X-Payment-Token": pix.token },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Pix indisponível (${response.status})`);
  return (await response.json()) as PixView;
}

/** "14:59" até vencer; "00:00" depois. */
export function pixCountdown(expiresAt: string, now: Date): string {
  const left = Math.max(0, Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 1000));
  return `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
}

const pixKey = (slug: string) => `dishdesk:pix:${slug}`;

/** Pix aberto neste navegador: um recarregar da página volta para o QR Code em vez de gerar outro. */
export function savePendingPix(slug: string, pix: PendingPix | null, store: Pick<Storage, "removeItem" | "setItem"> | undefined = storage()): void {
  try {
    if (pix) store?.setItem(pixKey(slug), JSON.stringify(pix));
    else store?.removeItem(pixKey(slug));
  } catch {
    // Sem armazenamento: recarregar a página perde o QR Code; o pagamento continua valendo na Pagar.me.
  }
}

export function pendingPix(slug: string, store: Pick<Storage, "getItem"> | undefined = storage()): PendingPix | null {
  try {
    const raw = store?.getItem(pixKey(slug));
    const pix = raw ? (JSON.parse(raw) as Partial<PendingPix>) : null;
    return pix?.paymentId && pix.token && pix.qrCode ? (pix as PendingPix) : null;
  } catch {
    return null;
  }
}

// ---------- Armazenamento ----------

const pendingKey = (slug: string) => `dishdesk:order-key:${slug}`;
const tokenKey = (id: string) => `dishdesk:order:${id}`;

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16));
}

/** Chave do envio: a mesma até o pedido entrar (o "Tentar de novo" e um recarregar da página não duplicam). */
export function pendingOrderKey(slug: string, store: Pick<Storage, "getItem" | "setItem"> | undefined = storage()): string {
  try {
    const saved = store?.getItem(pendingKey(slug));
    if (saved) return saved;
    const key = newKey();
    store?.setItem(pendingKey(slug), key);
    return key;
  } catch {
    return newKey();
  }
}

/** Pedido feito: esquece a chave e guarda o token do link de acompanhamento. */
export function orderPlaced(slug: string, id: string, token: string, store: Pick<Storage, "removeItem" | "setItem"> | undefined = storage()): void {
  try {
    store?.removeItem(pendingKey(slug));
    store?.setItem(tokenKey(id), token);
  } catch {
    // Sem armazenamento: o link do pedido abre só com a sessão do código.
  }
}

export function orderToken(id: string, store: Pick<Storage, "getItem"> | undefined = storage()): string | null {
  try {
    return store?.getItem(tokenKey(id)) ?? null;
  } catch {
    return null;
  }
}

// ---------- Confirmação (W15) ----------

const hhmm = (at: Date) =>
  new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Sao_Paulo" }).format(at);

/** Número principal do W15: previsão ou horário agendado. */
export function confirmationHead(order: Pick<PublicOrder, "mode" | "eta" | "placedAt" | "scheduledFor">, now: Date): { label: string; value: string } {
  if (order.scheduledFor) {
    const at = new Date(order.scheduledFor);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });
    return { label: `Agendado para ${day.format(at) === day.format(now) ? "hoje" : "amanhã"}`, value: hhmm(at) };
  }
  const placed = new Date(order.placedAt);
  if (!order.eta) return { label: order.mode === "PICKUP" ? "Retirada" : "Entrega", value: "o quanto antes" };
  if (order.mode === "PICKUP") return { label: "Fica pronto por volta das", value: hhmm(new Date(placed.getTime() + order.eta.maxMinutes * 60_000)) };
  const from = hhmm(new Date(placed.getTime() + order.eta.minMinutes * 60_000));
  const to = hhmm(new Date(placed.getTime() + order.eta.maxMinutes * 60_000));
  return { label: "Chega entre", value: from === to ? from : `${from} e ${to}` };
}

/** "Dinheiro na entrega · troco para R$ 100,00". */
export function paymentLine(order: Pick<PublicOrder, "mode" | "payment">): string {
  if (order.payment.method === "pix") return "Pago com Pix";
  const where = order.mode === "PICKUP" ? "na retirada" : "na entrega";
  const change = order.payment.method === "cash" && order.payment.changeForCents != null ? ` · troco para ${money(order.payment.changeForCents)}` : "";
  return `${PAY_NAME[order.payment.method]} ${where}${change}`;
}
