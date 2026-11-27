// Checkout do cardápio público (F3-07): identificação (código pelo WhatsApp ou visitante), entrega ou retirada,
// quando e endereço. Funções puras e chamadas da API, sem React, para testar sozinho. O estado escolhido fica no
// navegador (localStorage por slug); os dados salvos do cliente (endereços, pedidos) nunca: vêm de GET /me a cada vez
// e só com a sessão do código (R1). Pagamento e revisão são o F3-08 (rota /checkout/pagamento).

import type { CheckoutAddress } from "@dishdesk/shared";

// ---------- Telefone ----------

/** Só os dígitos do celular, sem o +55 (até 11). */
export function phoneDigits(input: string): string {
  let digits = input.replace(/\D/g, "");
  if (digits.length > 11 && digits.startsWith("55")) digits = digits.slice(2);
  return digits.slice(0, 11);
}

/** Máscara enquanto digita: "(11) 98765-4321" (celular) ou "(11) 3456-7890" (fixo). */
export function maskPhone(input: string): string {
  const d = phoneDigits(input);
  if (d.length === 0) return "";
  if (d.length <= 2) return `(${d}`;
  const ddd = d.slice(0, 2);
  const rest = d.slice(2);
  if (rest.length <= 4) return `(${ddd}) ${rest}`;
  const split = d.length === 11 ? 5 : 4;
  return `(${ddd}) ${rest.slice(0, split)}-${rest.slice(split)}`;
}

/** Celular brasileiro: DDD válido + 9 + 8 dígitos. */
export function isMobilePhone(input: string): boolean {
  return /^[1-9][1-9]9\d{8}$/.test(phoneDigits(input));
}

/** "+5511987654321", como a API espera. */
export const toApiPhone = (input: string): string => `+55${phoneDigits(input)}`;

// ---------- Estado do checkout ----------

export type CheckoutMode = "DELIVERY" | "PICKUP";
export type Slot = { start: string; end: string; day: "today" | "tomorrow"; label: string };
export type CheckoutWhen = { kind: "now" } | { kind: "scheduled"; slot: Slot };
export type Identity = { kind: "otp"; name: string; phone: string } | { kind: "guest"; name: string; phone: string };
export type Quote = { feeCents: number; eta: { minMinutes: number; maxMinutes: number }; freeDelivery: boolean };
export type AddressLabel = "Casa" | "Trabalho";

export type CheckoutAddressChoice =
  | { kind: "saved"; id: string; title: string; area: string; district: string | null }
  | { kind: "new"; address: CheckoutAddress; lat: number | null; lng: number | null; saveAs: AddressLabel | null };

export type CheckoutState = {
  identity: Identity | null;
  mode: CheckoutMode | null;
  when: CheckoutWhen | null;
  address: CheckoutAddressChoice | null;
  /** Cotação do modo e do endereço escolhidos (a taxa que o F3-08 mostra no resumo). */
  quote: Quote | null;
};

export const EMPTY_CHECKOUT: CheckoutState = { identity: null, mode: null, when: null, address: null, quote: null };

export type CheckoutScreen = "identify" | "fulfillment" | "address" | "payment";

/** Passo do indicador (Entrega, Pagamento, Revisão; sem fidelidade, R9). Identificação e endereço são do passo 1. */
export const stepOf = (screen: CheckoutScreen): 1 | 2 => (screen === "payment" ? 2 : 1);

/** Primeira tela que falta preencher: onde o checkout abre ao voltar. */
export function firstMissing(state: CheckoutState): CheckoutScreen {
  if (!state.identity || !state.identity.name.trim()) return "identify";
  if (!state.mode || !state.when) return "fulfillment";
  if (state.mode === "DELIVERY" && (!state.address || !state.quote)) return "address";
  return "payment";
}

/** Tela seguinte ao "Continuar". Retirada pula o endereço. */
export function nextScreen(screen: CheckoutScreen, state: CheckoutState): CheckoutScreen {
  if (screen === "identify") return "fulfillment";
  if (screen === "fulfillment") return state.mode === "DELIVERY" ? "address" : "payment";
  return "payment";
}

/** Tela do "Voltar"; null volta para a sacola (o cardápio). */
export function previousScreen(screen: CheckoutScreen, state: CheckoutState): CheckoutScreen | null {
  if (screen === "payment") return state.mode === "DELIVERY" ? "address" : "fulfillment";
  if (screen === "address") return "fulfillment";
  if (screen === "fulfillment") return "identify";
  return null;
}

/** Trocar o modo ou o horário invalida a cotação; trocar o modo para retirada também esquece o endereço. */
export function chooseMode(state: CheckoutState, mode: CheckoutMode): CheckoutState {
  if (state.mode === mode) return state;
  return { ...state, mode, quote: null, address: mode === "PICKUP" ? null : state.address };
}

/** Sair da conta ou trocar de visitante para código: nada do cliente anterior fica (endereço salvo, cotação). */
export function chooseIdentity(state: CheckoutState, identity: Identity | null): CheckoutState {
  const same = state.identity?.kind === identity?.kind && state.identity?.phone === identity?.phone;
  return same ? { ...state, identity } : { ...EMPTY_CHECKOUT, mode: state.mode, when: state.when, identity };
}

// ---------- Armazenamento ----------

export const checkoutKey = (slug: string) => `dishdesk:checkout:${slug}`;
const VERSION = 1;

export function loadCheckout(slug: string, storage: Pick<Storage, "getItem"> | undefined = safeStorage()): CheckoutState {
  try {
    const raw = storage?.getItem(checkoutKey(slug));
    if (!raw) return EMPTY_CHECKOUT;
    const parsed = JSON.parse(raw) as { v?: number; state?: CheckoutState };
    if (parsed.v !== VERSION || !parsed.state) return EMPTY_CHECKOUT;
    const state = { ...EMPTY_CHECKOUT, ...parsed.state };
    // Endereço salvo só vale com a sessão do código: nunca reaparece para um visitante (R1).
    if (state.identity?.kind !== "otp" && state.address?.kind === "saved") return { ...state, address: null, quote: null };
    return state;
  } catch {
    return EMPTY_CHECKOUT;
  }
}

export function saveCheckout(slug: string, state: CheckoutState, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(checkoutKey(slug), JSON.stringify({ v: VERSION, state }));
  } catch {
    // Sem armazenamento (aba anônima, bloqueio): o checkout vale só até fechar a página.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

// ---------- API ----------

const base = (slug: string) => `/api/public/menu/${encodeURIComponent(slug)}`;

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
}

async function messageOf(response: Response, fallback: string): Promise<{ message: string; retryAfterSeconds?: number }> {
  try {
    const json = (await response.json()) as { message?: unknown; retryAfterSeconds?: unknown };
    const message = Array.isArray(json.message) ? String(json.message[0]) : typeof json.message === "string" ? json.message : fallback;
    return { message, retryAfterSeconds: typeof json.retryAfterSeconds === "number" ? json.retryAfterSeconds : undefined };
  } catch {
    return { message: fallback };
  }
}

export type OtpRequestOutcome =
  | { kind: "sent"; resendInSeconds: number }
  /** Sem WhatsApp do restaurante conectado ou o envio falhou: o cardápio oferece seguir como visitante. */
  | { kind: "unavailable" }
  | { kind: "wait"; message: string; retryAfterSeconds: number | null }
  | { kind: "error"; message: string };

export async function requestOtp(slug: string, phone: string): Promise<OtpRequestOutcome> {
  try {
    const response = await post(`${base(slug)}/otp/request`, { phone: toApiPhone(phone) });
    if (response.ok) {
      const json = (await response.json()) as { available: boolean; resendInSeconds?: number };
      return json.available ? { kind: "sent", resendInSeconds: json.resendInSeconds ?? 45 } : { kind: "unavailable" };
    }
    const { message, retryAfterSeconds } = await messageOf(response, "Não conseguimos enviar o código.");
    if (response.status === 429) return { kind: "wait", message, retryAfterSeconds: retryAfterSeconds ?? null };
    return { kind: "error", message };
  } catch {
    return { kind: "error", message: "Sem conexão. Confira a internet e tente de novo." };
  }
}

/** Tentativas de cada código na API (OTP_MAX_ATTEMPTS). A API não diz quantas restam: a tela conta. */
export const OTP_MAX_ATTEMPTS = 5;

const justLoggedKey = (slug: string) => `dd-just-logged:${slug}`;

/** Marca o login pelo código, para o cardápio mostrar a boas-vindas do VIP uma vez. */
function markJustLoggedIn(slug: string): void {
  try {
    window.localStorage.setItem(justLoggedKey(slug), "1");
  } catch {
    // sem armazenamento: o cliente só não vê a boas-vindas
  }
}

/** true uma vez depois do login pelo código (e apaga a marca). */
export function takeJustLoggedIn(slug: string): boolean {
  try {
    const found = window.localStorage.getItem(justLoggedKey(slug)) === "1";
    if (found) window.localStorage.removeItem(justLoggedKey(slug));
    return found;
  } catch {
    return false;
  }
}

export type OtpVerifyOutcome = { kind: "ok" } | { kind: "wrong" } | { kind: "error"; message: string };

export async function verifyOtp(slug: string, input: { phone: string; code: string; marketingOptIn: boolean }): Promise<OtpVerifyOutcome> {
  try {
    const response = await post(`${base(slug)}/otp/verify`, { phone: toApiPhone(input.phone), code: input.code, marketingOptIn: input.marketingOptIn });
    if (response.ok) {
      markJustLoggedIn(slug);
      return { kind: "ok" };
    }
    if (response.status === 400) return { kind: "wrong" };
    return { kind: "error", message: (await messageOf(response, "Não conseguimos conferir o código.")).message };
  } catch {
    return { kind: "error", message: "Sem conexão. Confira a internet e tente de novo." };
  }
}

export type SavedAddress = {
  id: string;
  label: string | null;
  street: string;
  number: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  complement: string | null;
};
export type Me = { name: string | null; phone: string; addresses: SavedAddress[] };

/** Cliente da sessão do código; null sem sessão (401). */
export async function fetchMe(slug: string): Promise<Me | null> {
  const response = await fetch(`${base(slug)}/me`, { credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Cadastro indisponível (${response.status})`);
  return (await response.json()) as Me;
}

export async function logout(slug: string): Promise<void> {
  await post(`${base(slug)}/logout`, {});
}

export type QuoteResponse =
  | { ok: true; feeCents: number; freeDelivery: boolean; eta: { minMinutes: number; maxMinutes: number }; distanceKm?: number }
  | { ok: false; code: "OUT_OF_AREA" | "ADDRESS_REQUIRED" | "STORE_LOCATION_MISSING" | "PICKUP_DISABLED"; message: string };

export async function fetchQuote(
  slug: string,
  input: { mode: CheckoutMode; subtotalCents: number; address?: { district?: string | null; lat?: number | null; lng?: number | null } },
): Promise<QuoteResponse> {
  const response = await post(`${base(slug)}/delivery-quote`, input);
  if (!response.ok) throw new Error(`Entrega indisponível (${response.status})`);
  return (await response.json()) as QuoteResponse;
}

export async function fetchSlots(slug: string): Promise<Slot[]> {
  const response = await fetch(`${base(slug)}/slots`);
  if (!response.ok) throw new Error(`Horários indisponíveis (${response.status})`);
  return ((await response.json()) as { slots: Slot[] }).slots;
}

// ---------- CEP (ViaCEP, chamado do navegador) ----------

export type CepResult = { ok: true; street: string; district: string; city: string; state: string } | { ok: false; message: string };

export async function lookupCep(cep: string, fetcher: typeof fetch = fetch): Promise<CepResult> {
  const digits = cep.replace(/\D/g, "");
  if (digits.length !== 8) return { ok: false, message: "O CEP tem 8 números." };
  try {
    const response = await fetcher(`https://viacep.com.br/ws/${digits}/json/`);
    if (!response.ok) return { ok: false, message: "Não achamos esse CEP. Confira ou preencha o endereço." };
    const json = (await response.json()) as { erro?: unknown; logradouro?: string; bairro?: string; localidade?: string; uf?: string };
    if (json.erro) return { ok: false, message: "Não achamos esse CEP. Confira ou preencha o endereço." };
    return { ok: true, street: json.logradouro ?? "", district: json.bairro ?? "", city: json.localidade ?? "", state: json.uf ?? "" };
  } catch {
    return { ok: false, message: "A busca do CEP não respondeu. Preencha o endereço." };
  }
}

/** "05435-000". */
export function maskCep(input: string): string {
  const d = input.replace(/\D/g, "").slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

// ---------- Textos ----------

export const etaLabel = (eta: { minMinutes: number; maxMinutes: number }): string =>
  eta.minMinutes === eta.maxMinutes ? `${eta.maxMinutes} min` : `${eta.minMinutes}–${eta.maxMinutes} min`;

const hhmm = (at: Date) =>
  new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Sao_Paulo" }).format(at);

/** "chega entre 20:10 e 20:20" a partir de agora. */
export function arrivalWindow(eta: { minMinutes: number; maxMinutes: number }, now: Date): string {
  const from = new Date(now.getTime() + eta.minMinutes * 60_000);
  const to = new Date(now.getTime() + eta.maxMinutes * 60_000);
  return eta.minMinutes === eta.maxMinutes ? hhmm(from) : `entre ${hhmm(from)} e ${hhmm(to)}`;
}

/** "Hoje, sex 21" / "Amanhã, sáb 22" (horário de Brasília). */
export function dayLabel(day: "today" | "tomorrow", now: Date): string {
  const at = new Date(now.getTime() + (day === "tomorrow" ? 86_400_000 : 0));
  const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "short", timeZone: "America/Sao_Paulo" }).format(at).replace(".", "");
  const date = new Intl.DateTimeFormat("pt-BR", { day: "numeric", timeZone: "America/Sao_Paulo" }).format(at);
  return `${day === "today" ? "Hoje" : "Amanhã"}, ${weekday} ${date}`;
}

/** Hora de início da faixa ("19:30"). */
export const slotStart = (slot: Slot): string => slot.label.split("–")[0] ?? slot.label;

/** "hoje 19:30" / "amanhã 11:00": no botão e no resumo (R2). */
export const whenLabel = (slot: Slot): string => `${slot.day === "today" ? "hoje" : "amanhã"} ${slotStart(slot)}`;

/** Título do endereço salvo. ContactAddress tem `label`; sem rótulo, a rua vira o título. */
export function savedAddressTitle(address: SavedAddress): { label: string | null; street: string; area: string } {
  const street = [address.street, address.number, address.complement].filter((p) => p && p.trim()).join(", ");
  const area = [address.district, address.city].filter((p) => p && p.trim()).join(" · ");
  return { label: address.label?.trim() || null, street, area };
}

/** Link "Falar com a loja": WhatsApp do telefone da loja quando houver. */
export function storeContactLink(phone: string | null): string | null {
  const digits = phone?.replace(/\D/g, "") ?? "";
  if (digits.length < 10) return null;
  return `https://wa.me/${digits.startsWith("55") ? digits : `55${digits}`}`;
}
