// Consentimento do visitante para a medição de anúncios (F7-03, LGPD). Sem "Aceitar", o Pixel da Meta não carrega;
// a escolha (ou a falta dela) vai em cada evento do funil, para ficar registrada no servidor.

export type AdsConsent = "granted" | "denied" | "unset";

const KEY = "dd-consent";
export const CONSENT_EVENT = "dd:consent";

export function adsConsent(): AdsConsent {
  try {
    if (typeof window === "undefined") return "unset";
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as { ads?: boolean }) : null;
    return parsed?.ads === true ? "granted" : parsed?.ads === false ? "denied" : "unset";
  } catch {
    return "unset";
  }
}

export function setAdsConsent(granted: boolean): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ads: granted, at: Date.now() }));
  } catch {
    // Sem armazenamento: a escolha vale só nesta página.
  }
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: { granted } }));
}
