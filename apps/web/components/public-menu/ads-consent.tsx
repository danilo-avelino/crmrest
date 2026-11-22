"use client";

import { useEffect, useState } from "react";
import { type AdsConsent, adsConsent, CONSENT_EVENT, setAdsConsent } from "@/lib/consent";

type Fbq = ((...args: unknown[]) => void) & { callMethod?: (...args: unknown[]) => void; queue?: unknown[]; loaded?: boolean; version?: string; push?: unknown };
declare global {
  interface Window {
    fbq?: Fbq;
    _fbq?: Fbq;
  }
}

// Evento do funil -> evento padrão da Meta. Purchase só sai pelo servidor (F7-04), depois do pagamento confirmado.
const META_EVENT: Record<string, string> = {
  PAGE_VIEW: "PageView",
  VIEW_CONTENT: "ViewContent",
  SEARCH: "Search",
  ADD_TO_CART: "AddToCart",
  INITIATE_CHECKOUT: "InitiateCheckout",
};

/** Carrega o fbevents.js da Meta (o trecho oficial, sem o noscript) e inicia o Pixel. */
function loadPixel(pixelId: string) {
  if (window.fbq) return;
  const fbq: Fbq = function (...args: unknown[]) {
    if (fbq.callMethod) fbq.callMethod(...args);
    else fbq.queue!.push(args);
  } as Fbq;
  fbq.queue = [];
  fbq.loaded = true;
  fbq.version = "2.0";
  fbq.push = fbq;
  window.fbq = fbq;
  window._fbq = fbq;
  const script = document.createElement("script");
  script.async = true;
  script.src = "https://connect.facebook.net/en_US/fbevents.js";
  document.head.appendChild(script);
  fbq("init", pixelId);
}

/**
 * Pixel da Meta no cardápio público (F7-03): só carrega com "Aceitar". Repete os eventos do funil do Dish Desk com o
 * mesmo `eventID`, para a Meta deduplicar com a Conversions API (F7-04).
 */
export function MetaPixel({ pixelId }: { pixelId: string | null | undefined }) {
  const [consent, setConsent] = useState<AdsConsent>("unset");

  useEffect(() => {
    const sync = () => setConsent(adsConsent());
    sync();
    window.addEventListener(CONSENT_EVENT, sync);
    return () => window.removeEventListener(CONSENT_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!pixelId || consent !== "granted") return;
    loadPixel(pixelId);
    const onFunnel = (event: Event) => {
      const { stage, eventId, itemId, valueCents } = (event as CustomEvent<{ stage: string; eventId: string; itemId: string | null; valueCents: number | null }>).detail;
      const name = META_EVENT[stage];
      if (!name || !window.fbq) return;
      const params: Record<string, unknown> = { currency: "BRL" };
      if (valueCents != null) params.value = valueCents / 100;
      if (itemId) {
        params.content_ids = [itemId];
        params.content_type = "product";
      }
      window.fbq("track", name, params, { eventID: eventId });
    };
    window.addEventListener("dd:funnel", onFunnel);
    return () => window.removeEventListener("dd:funnel", onFunnel);
  }, [pixelId, consent]);

  return null;
}

/**
 * W18: aviso de cookies na base da tela, sem cobrir o botão da sacola. Só aparece se a loja usa o Pixel e o visitante
 * ainda não escolheu. "Preferências" mostra a única opção (medição de anúncios); recusar é tão fácil quanto aceitar.
 */
export function ConsentBanner({ pixelId }: { pixelId: string | null | undefined }) {
  const [consent, setConsent] = useState<AdsConsent>("granted");
  const [details, setDetails] = useState(false);

  useEffect(() => {
    // Lê no navegador: no servidor não há escolha salva.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConsent(adsConsent());
  }, []);

  if (!pixelId || consent !== "unset") return null;
  const choose = (granted: boolean) => {
    setAdsConsent(granted);
    setConsent(granted ? "granted" : "denied");
  };
  return (
    <div role="dialog" aria-label="Cookies e medição de anúncios" className="fixed inset-x-3 bottom-20 z-40 mx-auto max-w-lg rounded-xl border border-rule bg-surface p-4 shadow-lg lg:bottom-4">
      <p className="m-0 text-[13px] text-ink">
        Usamos cookies da Meta para medir os anúncios desta loja. Você escolhe: o cardápio funciona igual nos dois casos.
      </p>
      {details && (
        <p className="mt-2 mb-0 text-[12px] text-ink-2">
          Medição de anúncios (Meta Pixel): registra visitas, itens vistos e a sacola para a loja saber de qual anúncio você veio. Não usamos para outro fim.
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="h-11 flex-1 rounded-md bg-ink px-4 font-medium text-paper" onClick={() => choose(true)}>
          Aceitar
        </button>
        <button type="button" className="h-11 flex-1 rounded-md border border-rule bg-surface px-4 font-medium" onClick={() => choose(false)}>
          Recusar
        </button>
        {!details && (
          <button type="button" className="h-11 px-2 text-[13px] font-medium underline" onClick={() => setDetails(true)}>
            Preferências
          </button>
        )}
      </div>
    </div>
  );
}
