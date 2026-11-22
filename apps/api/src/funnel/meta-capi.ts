import { createHash } from "node:crypto";
import type { Request } from "express";
import { clientIp } from "../public/public-throttler.guard.js";
import type { FunnelChannel, FunnelStage } from "./funnel.service.js";

/** Nome do evento padrão da Meta para cada etapa do funil. */
export const META_EVENT: Record<FunnelStage, string> = {
  PAGE_VIEW: "PageView",
  VIEW_CONTENT: "ViewContent",
  SEARCH: "Search",
  ADD_TO_CART: "AddToCart",
  INITIATE_CHECKOUT: "InitiateCheckout",
  ADD_PAYMENT_INFO: "AddPaymentInfo",
  PURCHASE: "Purchase",
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Telefone normalizado como a Meta pede (só dígitos, com o DDI) e com hash. */
export const hashedPhone = (phone: string | null | undefined): string | null => {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? sha256(digits) : null;
};

/**
 * Com o consentimento do visitante (F7-03), o servidor guarda o navegador e o IP do pedido HTTP no evento: a Meta exige
 * os dois em eventos do site. Sem consentimento, nada disso é gravado.
 */
export function withClientInfo(attribution: Record<string, string>, request: Request): Record<string, string> {
  if (attribution.ads_consent !== "granted") return attribution;
  const ua = request.headers["user-agent"];
  const ip = clientIp(request);
  return { ...attribution, ...(typeof ua === "string" && ua ? { client_ua: ua.slice(0, 400) } : {}), ...(ip ? { client_ip: ip.slice(0, 64) } : {}) };
}

export type CapiSource = {
  eventId: string;
  stage: FunnelStage;
  channel: FunnelChannel;
  orderId: string | null;
  contactId: string | null;
  valueCents: number | null;
  attribution: Record<string, string>;
  createdAt: Date;
  phone: string | null;
};

/**
 * O evento como a Conversions API recebe, ou o motivo de não enviar. Só sai evento do site, com consentimento, e o
 * `event_id` é o mesmo do Pixel (dedup). O INITIATE_CHECKOUT que o servidor grava junto com o pedido repete o do
 * navegador, então não vai. WhatsApp espera a F7-05 (referral do anúncio na API oficial).
 */
export function capiEvent(source: CapiSource, eventSourceUrl: string): { skip: string } | { event: Record<string, unknown> } {
  if (source.channel !== "WEB") return { skip: "skip: WhatsApp (F7-05)" };
  if (source.attribution.ads_consent !== "granted") return { skip: "skip: sem consentimento" };
  if (source.stage === "INITIATE_CHECKOUT" && source.orderId) return { skip: "skip: repete o do navegador" };
  const a = source.attribution;
  const ph = hashedPhone(source.phone);
  const user = {
    ...(ph ? { ph: [ph] } : {}),
    ...(source.contactId ? { external_id: [sha256(source.contactId)] } : {}),
    ...(a.fbc ? { fbc: a.fbc } : {}),
    ...(a.fbp ? { fbp: a.fbp } : {}),
    ...(a.client_ua ? { client_user_agent: a.client_ua } : {}),
    ...(a.client_ip ? { client_ip_address: a.client_ip } : {}),
  };
  if (!user.client_user_agent) return { skip: "skip: sem o navegador do visitante" };
  return {
    event: {
      event_name: META_EVENT[source.stage],
      event_time: Math.floor(source.createdAt.getTime() / 1000),
      event_id: source.eventId,
      action_source: "website",
      event_source_url: eventSourceUrl,
      user_data: user,
      ...(source.valueCents != null ? { custom_data: { value: source.valueCents / 100, currency: "BRL" } } : {}),
    },
  };
}
