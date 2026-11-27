// Cardápio no painel (F2-08): tipos da resposta de `GET /menu/:tenantId` e as regras de tela que não dependem do React.

export type Slot = { weekday: number; startMinute: number; endMinute: number };
export type MenuSize = { id: string; name: string; priceCents: number; sortOrder: number; active: boolean; allowsHalf?: boolean };
export type MenuItem = {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  priceCents: number | null;
  photoUrl: string | null;
  sortOrder: number;
  active: boolean;
  soldOut: boolean;
  allowsHalf: boolean;
  ingredients: string[];
  allergens: string[];
  servesPeople: number | null;
  tags: string[];
  synonyms: string[];
  aiNotes: string | null;
  /** Custo por unidade (margem do relatório) e preço promocional (só sem tamanhos); planilha, 26/11/2026. */
  costCents: number | null;
  promoPriceCents: number | null;
  sizes: MenuSize[];
  optionGroups: { groupId: string; sortOrder: number }[];
  availabilities: Slot[];
  pairsWith: { pairedItemId: string }[];
};
export type HalfPricing = "MAX" | "AVERAGE" | "SUM";
export type MenuCategory = {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  active: boolean;
  allowsHalf: boolean;
  halfPricing: HalfPricing;
  availabilities: Slot[];
  items: MenuItem[];
};
export type MenuOption = { id: string; groupId: string; choiceId: string; name: string; priceCents: number; sortOrder: number; active: boolean; soldOut: boolean };
export type MenuOptionGroup = { id: string; name: string; minSelect: number; maxSelect: number; sortOrder: number; options: MenuOption[] };
export type MenuTree = {
  menu: { id: string; name: string; active: boolean } | null;
  categories: MenuCategory[];
  optionGroups: MenuOptionGroup[];
};

export type ItemFilter = "all" | "soldOut" | "noPhoto" | "outOfHours" | "archived";
export const FILTER_LABEL: Record<ItemFilter, string> = {
  all: "Todos",
  soldOut: "Esgotados",
  noPhoto: "Sem foto",
  outOfHours: "Fora do horário",
  archived: "Arquivados",
};

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const money = (cents: number) => brl.format(cents / 100);

/** "R$ 34,90" ou "R$ 34,90 a R$ 56,90" (tamanhos); sem preço nenhum: "Sem preço". */
export function priceLabel(item: Pick<MenuItem, "priceCents" | "sizes">): string {
  const prices = item.sizes.filter((size) => size.active).map((size) => size.priceCents);
  if (prices.length === 0) return item.priceCents === null ? "Sem preço" : money(item.priceCents);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  return low === high ? money(low) : `${money(low)} a ${money(high)}`;
}

/** Texto do campo de preço ("34,90") para centavos; vazio ou inválido: null. */
export function parseCents(text: string): number | null {
  const clean = text.replace(/[^\d,.]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  if (!clean) return null;
  const value = Number(clean);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
}

export const centsText = (cents: number | null | undefined) => (cents == null ? "" : (cents / 100).toFixed(2).replace(".", ","));

/** Agora, no relógio de Brasília (o mesmo dos horários da loja): dia da semana (0 = domingo) e minutos desde a meia-noite. */
export function brasiliaClock(at: Date): { weekday: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { weekday, minute: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** Sem faixa: sempre disponível. Fim menor que o início vira o dia (continua no dia seguinte). */
export function inSlots(slots: Slot[], clock: { weekday: number; minute: number }): boolean {
  if (slots.length === 0) return true;
  return slots.some((slot) => {
    if (slot.endMinute > slot.startMinute) return slot.weekday === clock.weekday && clock.minute >= slot.startMinute && clock.minute < slot.endMinute;
    if (slot.weekday === clock.weekday && clock.minute >= slot.startMinute) return true;
    return (slot.weekday + 1) % 7 === clock.weekday && clock.minute < slot.endMinute;
  });
}

/** O item some fora do horário dele ou da categoria. */
export function itemOutOfHours(item: MenuItem, category: MenuCategory, clock: { weekday: number; minute: number }): boolean {
  return !inSlots(item.availabilities, clock) || !inSlots(category.availabilities, clock);
}

export type ItemNote = { kind: "photo" | "ia"; text: string; action: string };

/** Avisos colados no item, com a ação ao lado (regra 2 do design). */
export function itemNotes(item: MenuItem): ItemNote[] {
  const notes: ItemNote[] = [];
  if (!item.photoUrl) notes.push({ kind: "photo", text: "Sem foto. Itens com foto vendem mais no cardápio.", action: "Enviar foto" });
  if (item.ingredients.length === 0) notes.push({ kind: "ia", text: "Sem ingredientes: a IA não responde sobre este item.", action: "Completar para a IA" });
  return notes;
}

/** Quanto da aba "Para a IA" está preenchido (os 7 campos que a IA usa). */
export function aiProgress(item: Pick<MenuItem, "ingredients" | "allergens" | "servesPeople" | "tags" | "synonyms" | "aiNotes" | "pairsWith">): { done: number; total: number } {
  const filled = [
    item.ingredients.length > 0,
    item.allergens.length > 0,
    item.servesPeople != null,
    item.tags.length > 0,
    item.synonyms.length > 0,
    Boolean(item.aiNotes),
    item.pairsWith.length > 0,
  ];
  return { done: filled.filter(Boolean).length, total: filled.length };
}

export type MenuCounts = { items: number; soldOut: number; noPhoto: number; outOfHours: number; archived: number; categories: number; visibleNow: number };

/** Os números do bloco principal. Arquivados ficam fora da conta de itens. */
export function menuCounts(categories: MenuCategory[], clock: { weekday: number; minute: number }): MenuCounts {
  const counts: MenuCounts = { items: 0, soldOut: 0, noPhoto: 0, outOfHours: 0, archived: 0, categories: categories.length, visibleNow: 0 };
  for (const category of categories) {
    for (const item of category.items) {
      if (!item.active) {
        counts.archived += 1;
        continue;
      }
      counts.items += 1;
      const out = itemOutOfHours(item, category, clock);
      if (item.soldOut) counts.soldOut += 1;
      if (!item.photoUrl) counts.noPhoto += 1;
      if (out) counts.outOfHours += 1;
      if (category.active && !item.soldOut && !out) counts.visibleNow += 1;
    }
  }
  return counts;
}

export function matchesFilter(item: MenuItem, category: MenuCategory, filter: ItemFilter, clock: { weekday: number; minute: number }): boolean {
  if (filter === "archived") return !item.active;
  if (!item.active) return false;
  if (filter === "soldOut") return item.soldOut;
  if (filter === "noPhoto") return !item.photoUrl;
  if (filter === "outOfHours") return itemOutOfHours(item, category, clock);
  return true;
}

/** Move o elemento `from` para a posição `to` (arrastar e soltar). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

// ---- horários ----

/** A semana na tela começa na segunda; nos dados, 0 é domingo. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY_SHORT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"] as const;
export const WEEKDAY_LETTER = ["D", "S", "T", "Q", "Q", "S", "S"] as const;

export const clockText = (minutes: number) => {
  const total = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};
/** "18:30" para minutos; texto fora do formato: null. */
export function parseClock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[1]) < 24 && Number(match[2]) < 60 ? minutes : null;
}

/** Faixa na tela: vários dias com o mesmo horário. */
export type Range = { key: string; days: number[]; from: string; to: string };

/** Junta as faixas por dia da API em faixas de vários dias com o mesmo horário. */
export function slotsToRanges(slots: Slot[]): Range[] {
  const byHours = new Map<string, Range>();
  for (const slot of slots) {
    const id = `${slot.startMinute}-${slot.endMinute}`;
    const range = byHours.get(id) ?? { key: id, days: [], from: clockText(slot.startMinute), to: clockText(slot.endMinute) };
    range.days.push(slot.weekday);
    byHours.set(id, range);
  }
  return [...byHours.values()];
}

/** O contrário: uma faixa por dia marcado. Faixa sem dia ou com horário inválido vira erro em português. */
export function rangesToSlots(ranges: Range[]): { slots: Slot[] } | { error: string } {
  const slots: Slot[] = [];
  for (const range of ranges) {
    const start = parseClock(range.from);
    const end = parseClock(range.to);
    if (range.days.length === 0) return { error: "Marque ao menos um dia em cada faixa." };
    if (start === null || end === null) return { error: "Use horários no formato 18:00." };
    if (start === end) return { error: "O início e o fim não podem ser iguais." };
    // Fim 00:00 é meia-noite do dia seguinte.
    for (const weekday of range.days) slots.push({ weekday, startMinute: start, endMinute: end === 0 ? 1440 : end });
  }
  return { slots };
}

/** Horas por semana em que o item aparece, dentro do horário da loja; só a loja fechada o tira da conta. */
export type StoreDay = { open: string; close: string }[];
export function weeklyMinutes(slots: Slot[], store: StoreDay[] | null): number {
  let total = 0;
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let minute = 0; minute < 1440; minute += 5) {
      const clock = { weekday, minute };
      if (inSlots(slots, clock) && (store === null || storeOpen(store, clock))) total += 5;
    }
  }
  return total;
}

/** Loja aberta no minuto? Turno que passa da meia-noite continua no dia seguinte. */
export function storeOpen(days: StoreDay[], clock: { weekday: number; minute: number }): boolean {
  const covers = (shifts: StoreDay, minute: number, carried: boolean) =>
    shifts.some((shift) => {
      const open = parseClock(shift.open) ?? 0;
      const close = parseClock(shift.close) ?? 0;
      if (close > open) return !carried && minute >= open && minute < close;
      return carried ? minute < close : minute >= open;
    });
  return covers(days[clock.weekday] ?? [], clock.minute, false) || covers(days[(clock.weekday + 6) % 7] ?? [], clock.minute, true);
}

/** "Disponível 8 h por semana" / "Disponível 7 h 30 min por semana". */
export function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `Disponível ${h} h${m ? ` ${m} min` : ""} por semana`;
}

/** Texto do grupo para o cliente: "Borda · Opcional · escolha 1" / "até 3". */
export function groupRuleLabel(group: Pick<MenuOptionGroup, "name" | "minSelect" | "maxSelect">): string {
  const required = group.minSelect >= 1;
  const choice = group.minSelect === group.maxSelect ? `escolha ${group.maxSelect}` : group.maxSelect === 1 ? "escolha 1" : `até ${group.maxSelect}`;
  return `${group.name} · ${required ? "Obrigatório" : "Opcional"} · ${choice}`;
}

export const HALF_RULES: { value: HalfPricing; name: string; text: string }[] = [
  { value: "MAX", name: "Maior preço", text: "O preço é o da metade mais cara." },
  { value: "AVERAGE", name: "Média", text: "O preço é a média das duas metades." },
  { value: "SUM", name: "Soma das metades", text: "O preço é a soma da metade de cada sabor." },
];
