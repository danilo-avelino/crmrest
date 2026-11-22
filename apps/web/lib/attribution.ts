// Origem da visita (F7-02) e eventos do funil do navegador (F7-01): na 1ª visita guarda UTMs, fbclid (vira o _fbc da
// Meta), _fbp e referrer, por loja, por 30 dias (primeiro toque). Cada evento do funil leva essa origem e um id de
// sessão anônimo deste navegador; o pedido leva os dois para ligar a venda à origem.

import { adsConsent } from "./consent";

export type Attribution = Partial<Record<"utm_source" | "utm_medium" | "utm_campaign" | "utm_content" | "utm_term" | "fbclid" | "fbc" | "fbp" | "referrer" | "ads_consent", string>>;
export type BrowserStage = "PAGE_VIEW" | "VIEW_CONTENT" | "SEARCH" | "ADD_TO_CART" | "INITIATE_CHECKOUT";

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
const attrKey = (slug: string) => `dd-attr:${slug}`;
const SESSION_KEY = "dd-sid";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

const clip = (value: string | null | undefined) => (value ? value.trim().slice(0, 300) || undefined : undefined);

/** Origem a partir do endereço, do referrer e dos cookies da Meta. `now` em ms. */
export function attributionFrom(url: URL, referrer: string, cookies: string, now: number): Attribution {
  const out: Attribution = {};
  for (const key of UTM_KEYS) {
    const value = clip(url.searchParams.get(key));
    if (value) out[key] = value;
  }
  const fbclid = clip(url.searchParams.get("fbclid"));
  const cookie = (name: string) => clip(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookies)?.[1]);
  if (fbclid) {
    out.fbclid = fbclid;
    out.fbc = `fb.1.${now}.${fbclid}`; // formato do parâmetro fbc da Meta
  } else if (cookie("_fbc")) {
    out.fbc = cookie("_fbc");
  }
  const fbp = cookie("_fbp");
  if (fbp) out.fbp = fbp;
  // Referrer só de fora do próprio cardápio.
  try {
    const ref = referrer ? new URL(referrer) : null;
    if (ref && ref.host !== url.host) out.referrer = clip(ref.origin + ref.pathname);
  } catch {
    // referrer inválido: ignora
  }
  return out;
}

/** Primeiro toque: guarda a origem da 1ª visita com algo de campanha; uma visita nova com campanha substitui depois de 30 dias. */
export function rememberAttribution(slug: string, current: Attribution, now: number, store: StorageLike | undefined = storage()): Attribution {
  let saved: { at: number; value: Attribution } | null = null;
  try {
    const raw = store?.getItem(attrKey(slug));
    saved = raw ? (JSON.parse(raw) as { at: number; value: Attribution }) : null;
  } catch {
    saved = null;
  }
  const fresh = saved && now - saved.at < TTL_MS;
  const hasCampaign = Object.keys(current).some((key) => key !== "fbp");
  if (fresh && saved) return { ...saved.value, ...(current.fbp ? { fbp: current.fbp } : {}) };
  if (!hasCampaign && saved) return { ...(current.fbp ? { fbp: current.fbp } : {}) };
  try {
    store?.setItem(attrKey(slug), JSON.stringify({ at: now, value: current }));
  } catch {
    // sem armazenamento: vale só para esta página
  }
  return current;
}

/** Id anônimo deste navegador (não identifica a pessoa), para contar visitantes e ligar os eventos ao pedido. */
export function browserSessionId(store: StorageLike | undefined = storage()): string {
  try {
    const found = store?.getItem(SESSION_KEY);
    if (found && found.length >= 8) return found;
    const id = crypto.randomUUID();
    store?.setItem(SESSION_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

/** Origem desta visita (lê o endereço e guarda o primeiro toque) e a escolha de consentimento atual. Só no navegador. */
export function currentAttribution(slug: string): Attribution {
  if (typeof window === "undefined") return {};
  const origin = rememberAttribution(slug, attributionFrom(new URL(window.location.href), document.referrer, document.cookie, Date.now()), Date.now());
  return { ...origin, ads_consent: adsConsent() };
}

type TrackExtra = { itemId?: string | null; valueCents?: number | null; eventId?: string };

/** Evento do funil (não bloqueia a tela; erro de rede é ignorado). Devolve o eventId (o Pixel usa o mesmo, F7-03). */
export function track(slug: string, stage: BrowserStage, extra: TrackExtra = {}): string {
  const eventId = extra.eventId ?? (typeof crypto !== "undefined" ? crypto.randomUUID() : String(Date.now()));
  if (typeof window === "undefined") return eventId;
  const body = {
    eventId,
    stage,
    sessionId: browserSessionId(),
    itemId: extra.itemId ?? null,
    valueCents: extra.valueCents ?? null,
    attribution: currentAttribution(slug),
  };
  void fetch(`/api/public/menu/${encodeURIComponent(slug)}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
  window.dispatchEvent(new CustomEvent("dd:funnel", { detail: { stage, eventId, itemId: extra.itemId ?? null, valueCents: extra.valueCents ?? null } }));
  return eventId;
}
