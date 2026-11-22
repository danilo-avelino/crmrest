/**
 * Entrega do cardápio (F2-06): área, taxa, pedido mínimo, frete grátis, prazo e faixas de agendamento. Funções
 * puras sobre `menuStoreOf()` e `businessHoursOf()`; dinheiro em centavos inteiros.
 *
 * Aberto ou fechado segue o `isOpenAt` do shared (o mesmo da IA e da Inbox): horário desligado = sempre aberto.
 */
import { type BusinessHours, isOpenAt, type MenuStoreSettings } from "@dishdesk/shared";

export type FulfillmentMode = "DELIVERY" | "PICKUP";
export type DeliveryAddress = { district?: string | null; lat?: number | null; lng?: number | null };

export type DeliveryQuote =
  | {
      ok: true;
      mode: FulfillmentMode;
      /** Taxa já com o frete grátis aplicado. */
      feeCents: number;
      /** Taxa da área, antes do frete grátis. */
      areaFeeCents: number;
      freeDelivery: boolean;
      /** Quanto falta para o frete grátis (null: sem regra, já grátis ou retirada). */
      missingForFreeCents: number | null;
      minOrderCents: number;
      /** Quanto falta para o pedido mínimo (0: atingido). */
      missingForMinimumCents: number;
      eta: { minMinutes: number; maxMinutes: number };
      distanceKm?: number;
    }
  | { ok: false; code: "OUT_OF_AREA" | "ADDRESS_REQUIRED" | "STORE_LOCATION_MISSING" | "PICKUP_DISABLED"; message: string };

/** Sem acento, sem caixa e sem espaço sobrando: "São  José " = "sao jose". */
export function normalizeDistrict(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Distância em km entre dois pontos (haversine). */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Taxa da área do endereço, antes do frete grátis. */
function areaFee(
  store: MenuStoreSettings,
  address: DeliveryAddress,
): { ok: true; feeCents: number; distanceKm?: number } | Extract<DeliveryQuote, { ok: false }> {
  if (store.delivery.mode === "BY_DISTRICT") {
    if (!address.district?.trim()) return { ok: false, code: "ADDRESS_REQUIRED", message: "Informe o bairro." };
    const wanted = normalizeDistrict(address.district);
    const area = store.delivery.districts.find((d) => normalizeDistrict(d.district) === wanted);
    if (!area) return { ok: false, code: "OUT_OF_AREA", message: "Ainda não entregamos nesse bairro." };
    return { ok: true, feeCents: area.feeCents };
  }
  const { lat, lng } = store.address;
  if (lat == null || lng == null) return { ok: false, code: "STORE_LOCATION_MISSING", message: "A loja ainda não tem localização." };
  if (address.lat == null || address.lng == null) return { ok: false, code: "ADDRESS_REQUIRED", message: "Informe o endereço." };
  const distanceKm = haversineKm({ lat, lng }, { lat: address.lat, lng: address.lng });
  // A faixa menor que cobre a distância.
  const radius = [...store.delivery.radii].sort((a, b) => a.maxKm - b.maxKm).find((r) => distanceKm <= r.maxKm);
  if (!radius) return { ok: false, code: "OUT_OF_AREA", message: "O endereço está fora da nossa área de entrega." };
  return { ok: true, feeCents: radius.feeCents, distanceKm };
}

/**
 * Cotação da entrega ou da retirada para um subtotal. Frete grátis só com o subtotal no piso ou acima (R11). O
 * pedido mínimo não bloqueia aqui: volta `missingForMinimumCents` para a sacola e o checkout decidirem.
 */
export function quoteDelivery(
  store: MenuStoreSettings,
  input: { mode: FulfillmentMode; subtotalCents: number; address?: DeliveryAddress },
): DeliveryQuote {
  const missingForMinimumCents = Math.max(0, store.minOrderCents - input.subtotalCents);
  if (input.mode === "PICKUP") {
    if (!store.pickupEnabled) return { ok: false, code: "PICKUP_DISABLED", message: "A loja não aceita retirada." };
    return {
      ok: true,
      mode: "PICKUP",
      feeCents: 0,
      areaFeeCents: 0,
      freeDelivery: false,
      missingForFreeCents: null,
      minOrderCents: store.minOrderCents,
      missingForMinimumCents,
      eta: { minMinutes: store.prepMinutes, maxMinutes: store.prepMinutes },
    };
  }
  const area = areaFee(store, input.address ?? {});
  if (!area.ok) return area;
  const threshold = store.freeDeliveryFromCents;
  const freeDelivery = threshold != null && input.subtotalCents >= threshold;
  return {
    ok: true,
    mode: "DELIVERY",
    feeCents: freeDelivery ? 0 : area.feeCents,
    areaFeeCents: area.feeCents,
    freeDelivery,
    missingForFreeCents: threshold == null || freeDelivery ? null : threshold - input.subtotalCents,
    minOrderCents: store.minOrderCents,
    missingForMinimumCents,
    eta: { minMinutes: store.deliveryMinMinutes, maxMinutes: store.deliveryMaxMinutes },
    ...(area.distanceKm != null ? { distanceKm: area.distanceKm } : {}),
  };
}

/** Faixa de taxas para mostrar antes do endereço (R11): menor e maior taxa das áreas. null: sem áreas. */
export function feeRangeOf(store: MenuStoreSettings): { minCents: number; maxCents: number } | null {
  const fees = store.delivery.mode === "BY_DISTRICT" ? store.delivery.districts.map((d) => d.feeCents) : store.delivery.radii.map((r) => r.feeCents);
  return fees.length ? { minCents: Math.min(...fees), maxCents: Math.max(...fees) } : null;
}

// ---------- Agendamento ----------

const MINUTE = 60_000;
/** Brasília não tem horário de verão desde 2019: UTC−3 fixo. */
const BRASILIA_OFFSET_MINUTES = -180;

export type ScheduleSlot = { start: Date; end: Date; day: "today" | "tomorrow"; label: string };

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

/** Meia-noite de Brasília do dia de `at` (em UTC) e o dia da semana. */
function brasiliaMidnight(at: Date): { midnight: number; weekday: number } {
  const local = new Date(at.getTime() + BRASILIA_OFFSET_MINUTES * MINUTE);
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return { midnight: midnightLocal - BRASILIA_OFFSET_MINUTES * MINUTE, weekday: local.getUTCDay() };
}

const hhmm = (at: Date) =>
  new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/Sao_Paulo" }).format(at);

/**
 * Faixas de agendamento de hoje e amanhã (horário de Brasília). Cada turno é dividido em faixas de `slotMinutes` a
 * partir da abertura; vale a faixa que começa depois de `agora + max(antecedência, preparo)` e com a loja aberta. Com
 * a loja fechada agora, a primeira faixa é a da próxima abertura (R2). Agendamento desligado: lista vazia.
 */
export function scheduleSlots(store: MenuStoreSettings, hours: BusinessHours, now: Date): ScheduleSlot[] {
  if (!store.scheduling.enabled) return [];
  const { slotMinutes, minLeadMinutes } = store.scheduling;
  const earliest = now.getTime() + Math.max(minLeadMinutes, store.prepMinutes) * MINUTE;
  const { midnight: today, weekday } = brasiliaMidnight(now);
  const dayMs = 24 * 60 * MINUTE;
  const limit = today + 2 * dayMs; // fim de amanhã
  const always = [{ open: "00:00", close: "00:00" }];

  const starts = new Set<number>();
  // Ontem entra pelo turno que passa da meia-noite.
  for (let offset = -1; offset <= 1; offset++) {
    const dayStart = today + offset * dayMs;
    const shifts = hours.enabled ? (hours.days[(weekday + offset + 7) % 7] ?? []) : always;
    for (const shift of shifts) {
      const open = minutesOf(shift.open);
      let close = minutesOf(shift.close);
      if (close <= open) close += 24 * 60; // passa da meia-noite (00:00–00:00 = o dia inteiro)
      for (let m = open; m + slotMinutes <= close; m += slotMinutes) {
        const start = dayStart + m * MINUTE;
        if (start >= earliest && start < limit) starts.add(start);
      }
    }
  }

  return [...starts]
    .sort((a, b) => a - b)
    .filter((start) => !hours.enabled || isOpenAt(hours, new Date(start)))
    .map((start) => {
      const startDate = new Date(start);
      const endDate = new Date(start + slotMinutes * MINUTE);
      return { start: startDate, end: endDate, day: start < today + dayMs ? "today" : "tomorrow", label: `${hhmm(startDate)}–${hhmm(endDate)}` };
    });
}
