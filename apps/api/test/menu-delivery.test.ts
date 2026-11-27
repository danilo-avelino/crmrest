import { type BusinessHours, DEFAULT_MENU_STORE, isOpenAt, type MenuStoreSettings } from "@dishdesk/shared";
import { describe, expect, it } from "vitest";
import { feeRangeOf, haversineKm, quoteDelivery, scheduleSlots } from "../src/menu/delivery.js";

const store = (extra: Partial<MenuStoreSettings> = {}): MenuStoreSettings => ({
  ...DEFAULT_MENU_STORE,
  address: { ...DEFAULT_MENU_STORE.address, lat: -23.55, lng: -46.63 },
  delivery: {
    mode: "BY_DISTRICT",
    districts: [
      { district: "São José", feeCents: 500 },
      { district: "Centro", feeCents: 800 },
    ],
  },
  minOrderCents: 3000,
  freeDeliveryFromCents: 10000,
  ...extra,
});

const radius = store({
  delivery: {
    mode: "BY_RADIUS",
    radii: [
      { maxKm: 5, feeCents: 1000 },
      { maxKm: 2, feeCents: 500 },
    ],
  },
});

describe("DeliveryService: taxa e área (F2-06)", () => {
  it("bairro sem acento nem caixa encontra a área", () => {
    const quote = quoteDelivery(store(), { mode: "DELIVERY", subtotalCents: 5000, address: { district: "  sao  JOSE " } });
    expect(quote).toMatchObject({ ok: true, feeCents: 500, areaFeeCents: 500, freeDelivery: false, missingForFreeCents: 5000 });
    expect(quote.ok && quote.eta).toEqual({ minMinutes: 40, maxMinutes: 60 });
  });

  it("bairro fora da área e sem bairro", () => {
    expect(quoteDelivery(store(), { mode: "DELIVERY", subtotalCents: 5000, address: { district: "Lapa" } })).toMatchObject({ ok: false, code: "OUT_OF_AREA" });
    expect(quoteDelivery(store(), { mode: "DELIVERY", subtotalCents: 5000 })).toMatchObject({ ok: false, code: "ADDRESS_REQUIRED" });
  });

  it("R11: abaixo do piso paga frete; no piso ou acima é grátis", () => {
    const at = (subtotalCents: number) => quoteDelivery(store(), { mode: "DELIVERY", subtotalCents, address: { district: "Centro" } });
    expect(at(9999)).toMatchObject({ feeCents: 800, freeDelivery: false, missingForFreeCents: 1 });
    expect(at(10000)).toMatchObject({ feeCents: 0, areaFeeCents: 800, freeDelivery: true, missingForFreeCents: null });
    const semRegra = quoteDelivery(store({ freeDeliveryFromCents: undefined }), { mode: "DELIVERY", subtotalCents: 99999, address: { district: "Centro" } });
    expect(semRegra).toMatchObject({ feeCents: 800, freeDelivery: false, missingForFreeCents: null });
  });

  it("pedido mínimo", () => {
    expect(quoteDelivery(store(), { mode: "DELIVERY", subtotalCents: 2000, address: { district: "Centro" } })).toMatchObject({ missingForMinimumCents: 1000 });
    expect(quoteDelivery(store(), { mode: "DELIVERY", subtotalCents: 3000, address: { district: "Centro" } })).toMatchObject({ missingForMinimumCents: 0 });
  });

  it("retirada não paga taxa e usa o tempo de preparo", () => {
    expect(quoteDelivery(store(), { mode: "PICKUP", subtotalCents: 100 })).toMatchObject({ ok: true, feeCents: 0, eta: { minMinutes: 30, maxMinutes: 30 } });
    expect(quoteDelivery(store({ pickupEnabled: false }), { mode: "PICKUP", subtotalCents: 100 })).toMatchObject({ ok: false, code: "PICKUP_DISABLED" });
  });

  it("por raio: a menor faixa que cobre a distância", () => {
    // 0,01° de latitude ≈ 1,11 km.
    expect(haversineKm({ lat: -23.55, lng: -46.63 }, { lat: -23.56, lng: -46.63 })).toBeCloseTo(1.112, 2);
    const near = quoteDelivery(radius, { mode: "DELIVERY", subtotalCents: 5000, address: { lat: -23.56, lng: -46.63 } });
    expect(near).toMatchObject({ ok: true, feeCents: 500 });
    expect(quoteDelivery(radius, { mode: "DELIVERY", subtotalCents: 5000, address: { lat: -23.58, lng: -46.63 } })).toMatchObject({ feeCents: 1000 });
    expect(quoteDelivery(radius, { mode: "DELIVERY", subtotalCents: 5000, address: { lat: -23.7, lng: -46.63 } })).toMatchObject({ code: "OUT_OF_AREA" });
    const noStore = { ...radius, address: DEFAULT_MENU_STORE.address };
    expect(quoteDelivery(noStore, { mode: "DELIVERY", subtotalCents: 5000, address: { lat: -23.56, lng: -46.63 } })).toMatchObject({
      code: "STORE_LOCATION_MISSING",
    });
  });

  it("zona sem entrega recusa o endereço dentro dela, mesmo dentro do raio", () => {
    // Quadrado em volta de (-23.56, -46.63), dentro do raio de 2 km.
    const zone = { id: "z1", name: "Zona sem entrega", points: [{ lat: -23.555, lng: -46.635 }, { lat: -23.555, lng: -46.625 }, { lat: -23.565, lng: -46.625 }, { lat: -23.565, lng: -46.635 }] };
    const blocked = { ...radius, blockedZones: [zone] };
    expect(quoteDelivery(blocked, { mode: "DELIVERY", subtotalCents: 5000, address: { lat: -23.56, lng: -46.63 } })).toMatchObject({ ok: false, code: "OUT_OF_AREA" });
    expect(quoteDelivery(blocked, { mode: "DELIVERY", subtotalCents: 5000, address: { lat: -23.58, lng: -46.63 } })).toMatchObject({ ok: true, feeCents: 1000 });
    // Por bairro, vale quando o endereço tem lat/lng.
    const byDistrict = store({ blockedZones: [zone] });
    expect(quoteDelivery(byDistrict, { mode: "DELIVERY", subtotalCents: 5000, address: { district: "Centro", lat: -23.56, lng: -46.63 } })).toMatchObject({ ok: false, code: "OUT_OF_AREA" });
    expect(quoteDelivery(byDistrict, { mode: "DELIVERY", subtotalCents: 5000, address: { district: "Centro" } })).toMatchObject({ ok: true });
  });

  it("faixa de taxas antes do endereço", () => {
    expect(feeRangeOf(store())).toEqual({ minCents: 500, maxCents: 800 });
    expect(feeRangeOf(radius)).toEqual({ minCents: 500, maxCents: 1000 });
    expect(feeRangeOf(DEFAULT_MENU_STORE)).toBeNull();
  });
});

describe("DeliveryService: agendamento (R2)", () => {
  // Todo dia 18:00–23:00; sexta (5) com turno até 02:00.
  const hours: BusinessHours = {
    enabled: true,
    days: Array.from({ length: 7 }, (_, d) => (d === 5 ? [{ open: "18:00", close: "02:00" }] : [{ open: "18:00", close: "23:00" }])),
    closedMessage: "fechado",
  };
  const scheduling = { enabled: true, minLeadMinutes: 60, slotMinutes: 30 };
  // 2026-11-18 é quarta-feira. 15:00 em Brasília = 18:00 UTC.
  const brt = (iso: string) => new Date(`${iso}-03:00`);

  it("fechada agora: a primeira faixa é a da próxima abertura", () => {
    const slots = scheduleSlots(store({ scheduling }), hours, brt("2026-11-18T15:00"));
    expect(isOpenAt(hours, brt("2026-11-18T15:00"))).toBe(false);
    expect(slots[0]).toMatchObject({ start: brt("2026-11-18T18:00"), day: "today", label: "18:00–18:30" });
    expect(slots.filter((s) => s.day === "today")).toHaveLength(10); // 18:00 … 22:30
    expect(slots.at(-1)).toMatchObject({ start: brt("2026-11-19T22:30"), day: "tomorrow" });
    expect(slots.every((s) => isOpenAt(hours, s.start))).toBe(true);
  });

  it("aberta: respeita antecedência e preparo", () => {
    const slots = scheduleSlots(store({ scheduling, prepMinutes: 30 }), hours, brt("2026-11-18T19:10"));
    expect(slots[0]!.start).toEqual(brt("2026-11-18T20:30")); // 19:10 + 60 = 20:10, próxima faixa 20:30
    const slow = scheduleSlots(store({ scheduling: { ...scheduling, minLeadMinutes: 0 }, prepMinutes: 90 }), hours, brt("2026-11-18T19:10"));
    expect(slow[0]!.start).toEqual(brt("2026-11-18T21:00"));
  });

  it("depois do fechamento: só amanhã", () => {
    const slots = scheduleSlots(store({ scheduling }), hours, brt("2026-11-18T23:30"));
    expect(slots[0]).toMatchObject({ start: brt("2026-11-19T18:00"), day: "tomorrow" });
  });

  it("turno que passa da meia-noite", () => {
    const slots = scheduleSlots(store({ scheduling }), hours, brt("2026-11-20T23:00")); // sexta
    expect(slots[0]!.start).toEqual(brt("2026-11-21T00:00"));
    expect(slots.find((s) => s.start.getTime() === brt("2026-11-21T01:30").getTime())).toBeTruthy();
    expect(slots.find((s) => s.start.getTime() === brt("2026-11-21T02:00").getTime())).toBeUndefined();
    expect(slots[0]!.day).toBe("tomorrow");
  });

  it("agendamento desligado não tem faixas; horário desligado é o dia todo", () => {
    expect(scheduleSlots(store(), hours, brt("2026-11-18T15:00"))).toEqual([]);
    const slots = scheduleSlots(store({ scheduling, prepMinutes: 0 }), { ...hours, enabled: false }, brt("2026-11-18T15:00"));
    expect(slots[0]!.start).toEqual(brt("2026-11-18T16:00"));
    expect(slots).toHaveLength(16 + 48);
  });
});
