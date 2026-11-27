import type { MenuStoreSettings, UpdateMenuStoreRequest } from "@dishdesk/shared";
import { centsText, parseCents } from "@/lib/menu";

// Tela Configurações → Cardápio e entrega (C1): conversão entre os campos em texto (R$, km, minutos) e o que a API guarda
// (centavos e números inteiros). Sem React, para testar sozinho.

export type StoreResponse = { slug: string; accentDefault: string; store: MenuStoreSettings };

export type StoreForm = {
  street: string;
  number: string;
  district: string;
  city: string;
  state: string;
  zip: string;
  pickupEnabled: boolean;
  prepMinutes: string;
  /** BY_AREA: áreas desenhadas no mapa (aba Áreas de entrega); esta tela só mostra e mantém. */
  mode: "BY_DISTRICT" | "BY_RADIUS" | "BY_AREA";
  districts: { district: string; fee: string }[];
  radii: { maxKm: string; fee: string }[];
  minOrder: string;
  freeFrom: string;
  deliveryMin: string;
  deliveryMax: string;
  schedulingEnabled: boolean;
  minLeadMinutes: string;
  slotMinutes: string;
  showcaseItemIds: string[];
  showcaseHours: string;
  accentColor: string;
  brandTheme: boolean;
  phone: string;
  cnpj: string;
  about: string;
};

export function storeToForm(store: MenuStoreSettings, accentDefault: string): StoreForm {
  const { address, delivery, scheduling } = store;
  return {
    street: address.street,
    number: address.number,
    district: address.district,
    city: store.city || address.city,
    state: address.state,
    zip: address.zip,
    pickupEnabled: store.pickupEnabled,
    prepMinutes: String(store.prepMinutes),
    mode: delivery.mode,
    districts: delivery.mode === "BY_DISTRICT" ? delivery.districts.map((d) => ({ district: d.district, fee: centsText(d.feeCents) })) : [],
    radii: delivery.mode === "BY_RADIUS" ? delivery.radii.map((r) => ({ maxKm: String(r.maxKm).replace(".", ","), fee: centsText(r.feeCents) })) : [],
    minOrder: centsText(store.minOrderCents),
    freeFrom: centsText(store.freeDeliveryFromCents),
    deliveryMin: String(store.deliveryMinMinutes),
    deliveryMax: String(store.deliveryMaxMinutes),
    schedulingEnabled: scheduling.enabled,
    minLeadMinutes: String(scheduling.minLeadMinutes),
    slotMinutes: String(scheduling.slotMinutes),
    showcaseItemIds: store.promoShowcase.itemIds,
    showcaseHours: String(store.promoShowcase.frequencyHours),
    accentColor: store.accentColor ?? accentDefault,
    brandTheme: store.brandTheme ?? false,
    phone: store.phone ?? "",
    cnpj: store.cnpj ?? "",
    about: store.about ?? "",
  };
}

const whole = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);
const decimal = (text: string) => {
  const value = Number(text.trim().replace(",", "."));
  return text.trim() && Number.isFinite(value) ? value : null;
};

/**
 * Os campos para o corpo de `PUT /menu/:tenantId/store`, ou a mensagem do primeiro campo inválido. `base` traz o que a
 * tela não edita (formas de pagamento).
 */
export function formToPayload(form: StoreForm, base: MenuStoreSettings): { ok: true; body: UpdateMenuStoreRequest } | { ok: false; error: string } {
  const minutes = (label: string, text: string, max: number) => {
    const value = whole(text);
    return value !== null && value <= max ? value : `${label}: informe minutos de 0 a ${max}.`;
  };
  const money = (label: string, text: string) => {
    const value = parseCents(text);
    return value !== null ? value : `${label}: informe um valor em R$, como 8,50.`;
  };
  const prep = minutes("Preparo", form.prepMinutes, 600);
  const dMin = minutes("Prazo mínimo", form.deliveryMin, 600);
  const dMax = minutes("Prazo máximo", form.deliveryMax, 600);
  const lead = minutes("Antecedência", form.minLeadMinutes, 10080);
  const slot = whole(form.slotMinutes);
  const minOrder = money("Pedido mínimo", form.minOrder);
  const free = form.freeFrom.trim() ? money("Frete grátis", form.freeFrom) : undefined;
  for (const value of [prep, dMin, dMax, lead, minOrder, free]) if (typeof value === "string") return { ok: false, error: value };
  if (slot === null || slot < 5 || slot > 240) return { ok: false, error: "Faixa de horário: informe de 5 a 240 minutos." };
  if ((dMin as number) > (dMax as number)) return { ok: false, error: "O prazo mínimo não pode passar do máximo." };
  const showcaseHours = whole(form.showcaseHours);
  if (showcaseHours === null || showcaseHours < 1 || showcaseHours > 720) return { ok: false, error: "Vitrine: informe de 1 a 720 horas." };
  if (!/^#[0-9a-fA-F]{6}$/.test(form.accentColor)) return { ok: false, error: "Cor: use o formato #RRGGBB." };

  let delivery: UpdateMenuStoreRequest["delivery"];
  if (form.mode === "BY_AREA") {
    // As áreas desenhadas mudam só na aba Áreas de entrega: aqui ficam como estão.
    delivery = base.delivery.mode === "BY_AREA" ? base.delivery : { mode: "BY_AREA", areas: [] };
  } else if (form.mode === "BY_DISTRICT") {
    const districts = [];
    for (const row of form.districts) {
      const fee = parseCents(row.fee);
      if (!row.district.trim() || fee === null) return { ok: false, error: "Cada bairro precisa de nome e taxa em R$." };
      districts.push({ district: row.district.trim(), feeCents: fee });
    }
    delivery = { mode: "BY_DISTRICT", districts };
  } else {
    const radii = [];
    for (const row of form.radii) {
      const maxKm = decimal(row.maxKm);
      const fee = parseCents(row.fee);
      if (maxKm === null || maxKm <= 0 || maxKm > 200 || fee === null) return { ok: false, error: "Cada raio precisa de km (até 200) e taxa em R$." };
      radii.push({ maxKm, feeCents: fee });
    }
    delivery = { mode: "BY_RADIUS", radii };
  }

  const fields = { street: form.street, number: form.number, district: form.district, city: form.city, state: form.state.toUpperCase(), zip: form.zip };
  const old = base.address;
  const moved = (Object.keys(fields) as (keyof typeof fields)[]).some((k) => fields[k].trim() !== (k === "city" ? base.city || old.city : old[k]).trim());
  // Endereço novo: o ponto antigo da loja sai, e a aba Áreas de entrega acha o novo pelo CEP e pelo endereço.
  const address = moved ? { ...old, ...fields, lat: undefined, lng: undefined } : { ...old, ...fields };

  return {
    ok: true,
    body: {
      ...base,
      address,
      pickupEnabled: form.pickupEnabled,
      prepMinutes: prep as number,
      delivery,
      minOrderCents: minOrder as number,
      freeDeliveryFromCents: free as number | undefined,
      deliveryMinMinutes: dMin as number,
      deliveryMaxMinutes: dMax as number,
      scheduling: { enabled: form.schedulingEnabled, minLeadMinutes: lead as number, slotMinutes: slot },
      promoShowcase: { itemIds: form.showcaseItemIds.slice(0, 50), frequencyHours: showcaseHours },
      accentColor: form.accentColor,
      brandTheme: form.brandTheme,
      city: form.city,
      phone: form.phone,
      cnpj: form.cnpj,
      about: form.about,
    },
  };
}

/** Endereço público do cardápio do restaurante. */
export const publicMenuUrl = (origin: string, slug: string) => `${origin}/c/${slug}`;
