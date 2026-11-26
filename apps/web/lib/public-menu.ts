// Cardápio público (/c/[slug]): tipos da resposta de GET /api/public/menu/:slug e as funções puras da página
// (preço, faixa de entrega, busca). Sem React, para testar sozinho.

export type PublicMenuStatus = "open" | "closed" | "paused";
export type PublicPaymentMethod = "pix" | "cash" | "credit" | "debit" | "pix_on_delivery";

export type PublicMenuStore = {
  name: string;
  logoUrl: string | null;
  coverUrl: string | null;
  /** Cor de destaque (hex) do restaurante. */
  accentColor: string;
  /** Tema completo: a cor de destaque também tinge o fundo e as bordas (lib/menu-theme.ts). */
  brandTheme: boolean;
  city: string | null;
  address: string | null;
  phone: string | null;
  cnpj: string | null;
  about: string | null;
  /** Turnos de cada dia da semana (0 = domingo); null: sem horário configurado. */
  weekHours: { open: string; close: string }[][] | null;
  /** Só com a loja aberta: hora em que o turno atual termina. */
  closesAt: string | null;
  status: PublicMenuStatus;
  /** Só com a loja fechada: "hoje às 18:00", "amanhã às 11:00". */
  nextOpening: string | null;
  feeRange: { minCents: number; maxCents: number } | null;
  freeDeliveryFromCents: number | null;
  minOrderCents: number;
  pickupEnabled: boolean;
  deliveryEta: { minMinutes: number; maxMinutes: number };
  paymentMethods: PublicPaymentMethod[];
  schedulingEnabled: boolean;
  /** Vitrine de promoções (W3); ausente em API antiga. */
  promoShowcase?: { itemIds: string[]; frequencyHours: number };
  /** Pixel da Meta (F7-03); null sem Pixel. Ausente em API antiga. */
  metaPixelId?: string | null;
};

export type PublicMenuItem = {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  priceCents: number | null;
  /** Preço cheio quando o item está em promoção (aparece riscado); null sem promoção. */
  regularPriceCents?: number | null;
  photoUrl: string | null;
  soldOut: boolean;
  availableNow: boolean;
  allowsHalf: boolean;
  sizes: { id: string; name: string; priceCents: number }[];
  optionGroups: {
    id: string;
    name: string;
    minSelect: number;
    maxSelect: number;
    options: { id: string; name: string; priceCents: number; soldOut: boolean }[];
  }[];
  tags: string[];
  ingredients: string[];
  allergens: string[];
  servesPeople: number | null;
};

export type PublicMenuCategory = {
  id: string;
  name: string;
  description: string | null;
  allowsHalf: boolean;
  halfPricing: string;
  availableNow: boolean;
  items: PublicMenuItem[];
};

/** Aviso no topo do cardápio (aba Avisos, N5): só os que estão no ar agora. */
export type PublicNotice = { id: string; title: string; body: string | null; photoUrl: string | null };

export type PublicMenu = { store: PublicMenuStore; categories: PublicMenuCategory[]; notices?: PublicNotice[] };

/** Segundos que a página fica em cache (ISR) e que a API deixa no Cache-Control. */
export const MENU_REVALIDATE_SECONDS = 30;

/** Cardápio do slug; null quando a API diz que ele não existe, está desligado ou suspenso (sempre o mesmo 404). */
export async function fetchPublicMenu(slug: string): Promise<PublicMenu | null> {
  const base = process.env.API_URL ?? "http://localhost:4000";
  const response = await fetch(`${base}/api/public/menu/${encodeURIComponent(slug)}`, {
    next: { revalidate: MENU_REVALIDATE_SECONDS },
  });
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) throw new Error(`Cardápio indisponível (${response.status})`);
  return (await response.json()) as PublicMenu;
}

// ---------- Formatos ----------

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/** "R$ 49,90". */
export function money(cents: number): string {
  return brl.format(cents / 100);
}

/** "R$ 5" quando é inteiro, "R$ 7,90" quando não: para a faixa da entrega. */
export function moneyShort(cents: number): string {
  return cents % 100 === 0 ? brl.format(cents / 100).replace(",00", "") : money(cents);
}

/** "a partir de R$ 34,90 (broto)" com tamanhos, "R$ 49,90" sem eles; null quando não há preço. */
export function priceLabel(item: Pick<PublicMenuItem, "priceCents" | "sizes">): string | null {
  if (item.sizes.length > 0) {
    const cheapest = item.sizes.reduce((a, b) => (b.priceCents < a.priceCents ? b : a));
    return `a partir de ${money(cheapest.priceCents)} (${cheapest.name.toLowerCase()})`;
  }
  return item.priceCents == null ? null : money(item.priceCents);
}

/** Linhas da faixa da entrega (R11): "Entrega R$ 5 a R$ 12", "grátis acima de R$ 150", "40–50 min". */
export function deliveryStrip(store: PublicMenuStore): { text: string; highlight?: boolean }[] {
  const parts: { text: string; highlight?: boolean }[] = [];
  const range = store.feeRange;
  if (range) {
    parts.push({
      text: range.minCents === range.maxCents ? `Entrega ${moneyShort(range.minCents)}` : `Entrega ${moneyShort(range.minCents)} a ${moneyShort(range.maxCents)}`,
    });
  }
  if (store.freeDeliveryFromCents != null) parts.push({ text: `grátis acima de ${moneyShort(store.freeDeliveryFromCents)}`, highlight: true });
  const { minMinutes, maxMinutes } = store.deliveryEta;
  if (maxMinutes > 0) parts.push({ text: minMinutes === maxMinutes ? `${maxMinutes} min` : `${minMinutes}–${maxMinutes} min` });
  return parts;
}

export const PAYMENT_LABELS: Record<PublicPaymentMethod, string> = {
  pix: "Pix",
  cash: "Dinheiro",
  credit: "Cartão de crédito",
  debit: "Cartão de débito",
  pix_on_delivery: "Pix na maquininha",
};

// ---------- Selos ----------

export type Badge = { label: string; tone: "hot" | "new" | "veg" | "spicy" | "muted" };

const TAG_BADGES: { match: string; badge: Badge }[] = [
  { match: "mais pedido", badge: { label: "Mais pedido", tone: "hot" } },
  { match: "novidade", badge: { label: "Novidade", tone: "new" } },
  { match: "vegetariano", badge: { label: "Vegetariano", tone: "veg" } },
  { match: "picante", badge: { label: "Picante", tone: "spicy" } },
];

/** Selos do card: Esgotado (ou fora do horário) primeiro; depois os conhecidos entre as tags do item. */
export function badgesOf(item: Pick<PublicMenuItem, "soldOut" | "availableNow" | "tags">): Badge[] {
  if (item.soldOut) return [{ label: "Esgotado", tone: "muted" }];
  if (!item.availableNow) return [{ label: "Indisponível agora", tone: "muted" }];
  const tags = item.tags.map(fold);
  return TAG_BADGES.filter(({ match }) => tags.includes(match)).map(({ badge }) => badge);
}

/** Pode abrir a ficha: nem esgotado nem fora do horário. */
export function orderable(item: Pick<PublicMenuItem, "soldOut" | "availableNow">): boolean {
  return !item.soldOut && item.availableNow;
}

/** "Destaques" (R5): itens à venda marcados como mais pedido ou novidade, na ordem do cardápio. */
export function highlightsOf(categories: PublicMenuCategory[], limit = 6): PublicMenuItem[] {
  const picked: PublicMenuItem[] = [];
  for (const category of categories) {
    for (const item of category.items) {
      const tags = item.tags.map(fold);
      if (orderable(item) && (tags.includes("mais pedido") || tags.includes("novidade") || tags.includes("destaque"))) picked.push(item);
    }
  }
  return picked.slice(0, limit);
}

/** Itens da vitrine de promoções na ordem escolhida pela loja, só os que estão à venda agora (R4: nada esgotado). */
export function showcaseItems(categories: PublicMenuCategory[], itemIds: string[]): PublicMenuItem[] {
  const byId = new Map(categories.flatMap((category) => category.items).map((item) => [item.id, item]));
  return itemIds.map((id) => byId.get(id)).filter((item): item is PublicMenuItem => Boolean(item && orderable(item)));
}

/** A vitrine aparece de novo? No máximo uma vez a cada `frequencyHours` (R4). */
export function showcaseDue(lastShownAt: number | null, now: number, frequencyHours: number): boolean {
  return lastShownAt === null || !Number.isFinite(lastShownAt) || now - lastShownAt >= frequencyHours * 3_600_000;
}

/** Categorias que têm item: uma categoria vazia não aparece nas abas nem na lista. */
export function visibleCategories(categories: PublicMenuCategory[]): PublicMenuCategory[] {
  return categories.filter((category) => category.items.length > 0);
}

// ---------- Busca (no navegador, sobre o cardápio já carregado) ----------

/** Minúsculas e sem acento: "Muçarela" e "mucarela" são a mesma palavra. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

export type SearchHit = {
  item: PublicMenuItem;
  categoryName: string;
  /** Onde o termo apareceu: o nome do item ou só um ingrediente. */
  matchedIn: "name" | "ingredient";
};

/** Todas as palavras da busca precisam aparecer no nome ou nos ingredientes. Nome primeiro, depois ingrediente. */
export function searchMenu(categories: PublicMenuCategory[], query: string): SearchHit[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const byName: SearchHit[] = [];
  const byIngredient: SearchHit[] = [];
  for (const category of categories) {
    for (const item of category.items) {
      const name = fold(item.name);
      const all = `${name} ${item.ingredients.map(fold).join(" ")}`;
      if (!words.every((word) => all.includes(word))) continue;
      const inName = words.every((word) => name.includes(word));
      (inName ? byName : byIngredient).push({ item, categoryName: category.name, matchedIn: inName ? "name" : "ingredient" });
    }
  }
  return [...byName, ...byIngredient];
}

export type TextPart = { text: string; hit: boolean };

/** Quebra o texto nos trechos que casam com a busca (ignorando acento e caixa), para destacar com <mark>. */
export function highlightParts(text: string, query: string): TextPart[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [{ text, hit: false }];
  // Um caractere por caractere: o índice do texto dobrado é o mesmo do original.
  const folded = Array.from(text, (char) => {
    const single = fold(char);
    return single.length === 1 ? single : char.toLowerCase();
  }).join("");
  const marked = new Array<boolean>(text.length).fill(false);
  if (folded.length !== text.length) return [{ text, hit: false }];
  for (const word of words) {
    for (let from = folded.indexOf(word); from !== -1; from = folded.indexOf(word, from + word.length)) {
      marked.fill(true, from, from + word.length);
    }
  }
  const parts: TextPart[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts.at(-1);
    if (last && last.hit === marked[i]) last.text += text[i];
    else parts.push({ text: text[i]!, hit: marked[i]! });
  }
  return parts;
}

const WEEKDAY_NAMES = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

/** Horário da semana para a tela "Sobre a loja": um dia por linha, "fechado" sem turnos. */
export function weekHoursRows(weekHours: NonNullable<PublicMenuStore["weekHours"]>): [string, string][] {
  return weekHours.map((shifts, day) => [WEEKDAY_NAMES[day]!, shifts.length ? shifts.map((s) => `${s.open} às ${s.close}`).join(" e ") : "Fechado"]);
}
