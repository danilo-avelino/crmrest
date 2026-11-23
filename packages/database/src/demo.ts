// Conta de demonstração (apresentações de venda): um restaurante fictício completo, com quatro semanas de histórico e um
// dia de hoje movimentado. Tudo é recriado a cada execução, com as datas contadas a partir de agora: a demo sempre
// parece atual. Nomes, telefones e endereços são inventados; os telefones ficam na faixa +55 11 90000-xxxx.
// Quem usa: o script `pnpm demo:reset` (com a conexão de administrador) e o botão escondido da demo na API (sob a RLS).
import { randomBytes } from "node:crypto";
import { blindIndex, encrypt } from "./crypto.js";
import type { ChannelType, OrderStatus, Prisma } from "./generated/prisma/client.js";

type Tx = Prisma.TransactionClient;

export const DEMO_SLUG = "demo-vila-brasa";
export const DEMO_TENANT_NAME = "Pizzaria Vila Brasa";
/** Logins da demo: o primeiro é o administrador (o que vai para a apresentação). */
export const DEMO_USERS = [
  { key: "admin", email: "demo@dishdesk.com.br", name: "Marcelo Andrade", role: "ADMIN" },
  { key: "julia", email: "julia.demo@dishdesk.com.br", name: "Júlia Campos", role: "AGENT" },
  { key: "rafael", email: "rafael.demo@dishdesk.com.br", name: "Rafael Nunes", role: "AGENT" },
] as const;
export type DemoUserKey = (typeof DEMO_USERS)[number]["key"];

/** A marca da demo fica em `tenant.settings.demo`; só este seed a grava. */
export function isDemoSettings(settings: unknown): boolean {
  return typeof settings === "object" && settings !== null && (settings as { demo?: unknown }).demo === true;
}

export function isDemoEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return DEMO_USERS.some((user) => user.email === normalized);
}

export type DemoSummary = {
  contacts: number;
  couriers: number;
  conversations: number;
  conversationsToday: number;
  messages: number;
  orders: number;
  ordersToday: number;
  evaluations: number;
  ratings: number;
  funnelEvents: number;
};

// ---------- Utilidades ----------

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Brasília não tem horário de verão desde 2019: UTC-3 o ano todo. */
const BRT_OFFSET = 3 * 60 * MINUTE;

/** UUIDv7 com o horário do registro: a ordem pelos ids bate com a ordem no tempo, como nos dados reais. */
function uuid7(at: Date): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Math.max(0, at.getTime()));
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Sorteio com semente fixa: o mesmo conjunto de dados a cada reset (a apresentação pode ser ensaiada). */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const reais = (cents: number) => (cents / 100).toFixed(2);

// ---------- Dados fixos do restaurante ----------

const FIRST_NAMES = [
  "Ana", "Bruno", "Camila", "Diego", "Eduarda", "Felipe", "Gabriela", "Henrique", "Isabela", "João", "Karina", "Lucas",
  "Mariana", "Nicolas", "Olívia", "Pedro", "Rafaela", "Samuel", "Tatiane", "Vinícius", "Yasmin", "André", "Beatriz",
  "Caio", "Débora", "Enzo", "Fernanda", "Gustavo", "Helena", "Igor", "Juliana", "Leonardo", "Larissa", "Matheus",
  "Natália", "Otávio", "Priscila", "Renato", "Sabrina", "Thiago", "Valéria", "William", "Aline", "Carlos", "Daniela",
  "Eduardo", "Flávia", "Giovana", "Heitor", "Letícia", "Marcos", "Patrícia", "Ricardo", "Simone", "Túlio", "Vanessa",
];
const LAST_NAMES = [
  "Albuquerque", "Barreto", "Cardoso", "Damasceno", "Esteves", "Figueiredo", "Guimarães", "Holanda", "Junqueira",
  "Lacerda", "Magalhães", "Nogueira", "Pacheco", "Queiroz", "Rezende", "Sampaio", "Teixeira", "Valadares", "Xavier",
  "Bittencourt", "Coutinho", "Drummond", "Falcão", "Gouveia", "Leitão", "Medeiros", "Prado", "Siqueira", "Toledo",
];
/** Bairros da zona sul e oeste de São Paulo, com a taxa de entrega de cada um (em centavos). */
const DISTRICTS: [string, number][] = [
  ["Vila Mariana", 500], ["Moema", 600], ["Saúde", 700], ["Ipiranga", 800], ["Aclimação", 600], ["Paraíso", 500],
  ["Jabaquara", 900], ["Campo Belo", 800],
];
const STREETS = [
  "Rua das Begônias", "Rua Doutor Amâncio Prates", "Alameda dos Sabiás", "Rua Professora Lúcia Brandão",
  "Rua Jaguaretê-Mirim", "Avenida Itaporanga Verde", "Rua Coronel Ubirajara Lemos", "Rua das Hortênsias Claras",
  "Travessa Nova Aurora", "Rua Maestro Zequinha Lobo",
];

type MenuEntry = { name: string; category: string; cents: number; sizes?: [number, number, number] };
const MENU: MenuEntry[] = [
  { name: "Margherita", category: "Pizzas salgadas", cents: 5690, sizes: [3290, 4690, 5690] },
  { name: "Calabresa", category: "Pizzas salgadas", cents: 5990, sizes: [3490, 4990, 5990] },
  { name: "Portuguesa", category: "Pizzas salgadas", cents: 6290, sizes: [3690, 5290, 6290] },
  { name: "Frango com Catupiry", category: "Pizzas salgadas", cents: 6290, sizes: [3690, 5290, 6290] },
  { name: "Quatro Queijos", category: "Pizzas salgadas", cents: 6590, sizes: [3890, 5490, 6590] },
  { name: "Pepperoni", category: "Pizzas salgadas", cents: 6890, sizes: [3990, 5690, 6890] },
  { name: "Brasa da Casa", category: "Pizzas salgadas", cents: 7290, sizes: [4290, 5990, 7290] },
  { name: "Chocolate com Morango", category: "Pizzas doces", cents: 5490, sizes: [3290, 4490, 5490] },
  { name: "Romeu e Julieta", category: "Pizzas doces", cents: 5290, sizes: [3190, 4290, 5290] },
  { name: "Combo Família", category: "Combos", cents: 7490 },
  { name: "Combo Casal", category: "Combos", cents: 5990 },
  { name: "Guaraná Antarctica 2 L", category: "Bebidas", cents: 1200 },
  { name: "Coca-Cola 2 L", category: "Bebidas", cents: 1400 },
  { name: "Suco de laranja 500 ml", category: "Bebidas", cents: 900 },
  { name: "Água com gás 500 ml", category: "Bebidas", cents: 500 },
  { name: "Petit gâteau", category: "Sobremesas", cents: 1890 },
  { name: "Pudim", category: "Sobremesas", cents: 1290 },
];
const PIZZAS = MENU.filter((item) => item.category.startsWith("Pizzas"));
const DRINKS = MENU.filter((item) => item.category === "Bebidas");
const DESSERTS = MENU.filter((item) => item.category === "Sobremesas");

const CANCEL_REASONS = [
  "Cliente desistiu do pedido",
  "Endereço fora da área de entrega",
  "Pedido duplicado",
  "Restaurante sem um dos ingredientes",
];

// ---------- Settings ----------

function demoSettings(): Prisma.InputJsonObject {
  const shifts = [{ open: "10:00", close: "01:00" }];
  return {
    demo: true,
    personality: "acolhedor",
    businessHours: {
      enabled: true,
      days: Array.from({ length: 7 }, () => shifts),
      closedMessage:
        "Oi! A Vila Brasa está fechada agora 🍕 Abrimos todos os dias às 10h. Sua mensagem fica aqui e a gente responde assim que abrir.",
    },
    orderLinks: [
      { label: "Cardápio e pedido online", url: `https://www.dishdesk.com.br/c/${DEMO_SLUG}` },
      { label: "iFood", url: "https://www.ifood.com.br/" },
    ],
    orderForecast: { showQueue: true },
    reviewInvite: { enabled: true },
    adminNotifications: { phones: ["+5511900009001"], misconduct: true, weeklyReport: true },
    paused: false,
    menuStore: {
      address: { street: "Rua das Begônias", number: "410", district: "Vila Mariana", city: "São Paulo", state: "SP", zip: "04101-000" },
      pickupEnabled: true,
      prepMinutes: 25,
      delivery: { mode: "BY_DISTRICT", districts: DISTRICTS.map(([district, feeCents]) => ({ district, feeCents })) },
      minOrderCents: 3000,
      freeDeliveryFromCents: 12000,
      deliveryMinMinutes: 35,
      deliveryMaxMinutes: 55,
      paymentMethods: ["cash", "credit", "debit", "pix_on_delivery"],
      scheduling: { enabled: true, minLeadMinutes: 60, slotMinutes: 30 },
      promoShowcase: { itemIds: [], frequencyHours: 24 },
      accentColor: "#B4341A",
      city: "São Paulo",
      phone: "(11) 90000-9000",
      about: "Pizza de fermentação natural assada na brasa desde 2014. Massa leve, molho da casa e muçarela de búfala.",
    },
    menuAgent: {
      enabled: true,
      attendantName: "Bia",
      houseRules: "Ofereça o Combo Família quando o cliente pedir pizza grande e refrigerante separados.",
      suggestAddons: true,
      maxSuggestionsPerConversation: 2,
    },
    tagBenefits: {
      tags: {
        VIP: { enabled: true, freeDelivery: true, discountCents: 1000, minOrderCents: 6000, frequency: "MONTHLY" },
        Recorrente: { enabled: true, freeDelivery: true, discountCents: 0, minOrderCents: 8000, frequency: "EVERY_ORDER" },
        Novo: { enabled: true, freeDelivery: false, discountCents: 800, minOrderCents: 5000, frequency: "ONCE" },
        Sumido: { enabled: true, freeDelivery: false, discountCents: 1500, minOrderCents: 6000, frequency: "ONCE" },
      },
      recovery: { enabled: true, discountCents: 1500, freeDelivery: true, minOrderCents: 0, sendMessage: true },
    },
  };
}

// ---------- Limpeza ----------

/** Apaga os dados do restaurante da demo (o restaurante, os usuários e os módulos ficam). Ordem: dos filhos aos pais. */
export async function wipeDemoData(tx: Tx, tenantId: string): Promise<void> {
  const where = { where: { tenantId } };
  await tx.funnelEvent.deleteMany(where);
  await tx.payment.deleteMany(where);
  await tx.cartItem.deleteMany(where);
  await tx.cart.deleteMany(where);
  await tx.reviewInvite.deleteMany(where);
  await tx.rating.deleteMany(where);
  await tx.conversationEvaluation.deleteMany(where);
  await tx.aiOnlyAttendance.deleteMany(where);
  await tx.orderEvent.deleteMany(where);
  await tx.orderItem.deleteMany(where);
  await tx.order.deleteMany(where);
  await tx.message.deleteMany(where);
  await tx.conversation.deleteMany(where);
  await tx.consent.deleteMany(where);
  await tx.contactDuplicateReview.deleteMany(where);
  await tx.contactDuplicateDismissal.deleteMany(where);
  await tx.contactAddress.deleteMany(where);
  await tx.contactIdentity.deleteMany(where);
  await tx.contact.deleteMany(where);
  await tx.quickReply.deleteMany(where);
  await tx.menuImportRequest.deleteMany(where);
  await tx.menuItemPairing.deleteMany(where);
  await tx.menuAvailability.deleteMany(where);
  await tx.menuItemOptionGroup.deleteMany(where);
  await tx.menuOption.deleteMany(where);
  await tx.menuOptionGroup.deleteMany(where);
  await tx.menuItemSize.deleteMany(where);
  await tx.menuItem.deleteMany(where);
  await tx.menuCategory.deleteMany(where);
  await tx.menu.deleteMany(where);
  await tx.channel.deleteMany(where);
}

// ---------- Seed ----------

type Users = Record<DemoUserKey, string>;
type ContactSeed = {
  id: string;
  name: string;
  phone: string;
  district: string;
  street: string;
  number: string;
  instagram: string | null;
  tags: string[];
  firstSeenAt: Date;
  lastSeenAt: Date | null;
};
type OrderRow = Prisma.OrderCreateManyInput & { id: string; placedAt: Date; status: OrderStatus; contactId: string };
type MessageRow = Prisma.MessageCreateManyInput & { createdAt: Date };
type Line = { name: string; quantity: number; unitCents: number; options?: string[]; notes?: string };

/**
 * Recria os dados da demo no restaurante `tenantId`, com `now` como o "agora". O chamador apaga antes (wipeDemoData) e
 * roda tudo numa transação. Devolve o que foi criado.
 */
export async function seedDemoData(tx: Tx, input: { tenantId: string; users: Users; key: Buffer; now?: Date }): Promise<DemoSummary> {
  const { tenantId, users, key } = input;
  const now = input.now ?? new Date();
  const rand = prng(20261123);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const chance = (p: number) => rand() < p;
  const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const ago = (minutes: number) => new Date(now.getTime() - minutes * MINUTE);
  /** Meia-noite (Brasília) de `days` dias atrás. */
  const brtMidnight = (days: number) => {
    const local = new Date(now.getTime() - BRT_OFFSET);
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - days) + BRT_OFFSET);
  };
  const minutesSinceMidnight = Math.floor((now.getTime() - brtMidnight(0).getTime()) / MINUTE);

  // Só as configurações: a aplicação não altera o nome do restaurante (o script da demo cria com o nome certo).
  await tx.tenant.update({ where: { id: tenantId }, data: { settings: demoSettings() } });

  // ---------- Canais (todos "conectados"; os ids não existem nas plataformas e nada sai pela guarda da demo) ----------
  // Ids com cara de reais, únicos por restaurante (o par tipo + id é único no banco). O da loja iFood fica fora do formato
  // UUID de propósito: se a marca da demo se perdesse, um UUID desconhecido derrubaria o polling do iFood de todos.
  const digits = BigInt(`0x${tenantId.replace(/-/g, "").slice(-12)}`).toString().padStart(13, "0").slice(-13);
  const externalIds: Partial<Record<ChannelType, string>> = {
    WHATSAPP: `10${digits}`,
    INSTAGRAM: `1784${digits}`,
    IFOOD: `vilabrasa-${digits.slice(-6)}`,
    CARDAPIO_WEB: digits.slice(-5),
  };
  const channel = async (type: ChannelType, name: string) =>
    tx.channel.create({
      data: {
        tenantId,
        type,
        name,
        externalId: externalIds[type]!,
        credentials: encrypt(JSON.stringify({ accessToken: "demo" }), key),
        status: "CONNECTED",
        connectedAt: brtMidnight(90),
      },
      select: { id: true, type: true },
    });
  const whatsapp = await channel("WHATSAPP", "WhatsApp Vila Brasa");
  const instagram = await channel("INSTAGRAM", "@vilabrasa.pizzaria");
  const ifood = await channel("IFOOD", "Vila Brasa · iFood");
  const cardapioWeb = await channel("CARDAPIO_WEB", "Vila Brasa · Cardápio Web");

  await tx.quickReply.createMany({
    data: [
      ["atraso", "Poxa, sinto muito pela demora! Já falei com a cozinha e com o entregador, seu pedido sai em instantes. 🙏"],
      ["horario", "Funcionamos todos os dias, das 10h à 1h da manhã. 🍕"],
      ["taxa", "A taxa de entrega vai de R$ 5 a R$ 9, conforme o bairro. Acima de R$ 120 a entrega é grátis!"],
      ["pix", "Aceitamos Pix na entrega (maquininha), cartão de crédito, débito e dinheiro."],
      ["meia", "Sim! Todas as pizzas salgadas podem ser meio a meio, e vale o preço da metade mais cara."],
      ["obrigado", "Nós que agradecemos! Bom apetite e até a próxima. ❤️"],
    ].map(([shortcut, content]) => ({ tenantId, shortcut: shortcut!, content: content! })),
  });

  const menuIds = await seedMenu(tx, tenantId, now);

  // ---------- Clientes ----------
  const contacts: ContactSeed[] = [];
  const usedNames = new Set<string>();
  for (let i = 0; contacts.length < 110; i++) {
    const name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    if (usedNames.has(name)) continue;
    usedNames.add(name);
    const n = contacts.length + 1;
    contacts.push({
      id: "",
      name,
      phone: `+55119000${String(n).padStart(5, "0")}`,
      district: pick(DISTRICTS)[0],
      street: pick(STREETS),
      number: String(between(12, 1980)),
      instagram: chance(0.3) ? `${name.split(" ")[0]!.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")}.${n}` : null,
      tags: [],
      firstSeenAt: brtMidnight(between(30, 400)),
      lastSeenAt: null,
    });
  }
  // Peso de cada cliente nos pedidos: poucos pedem muito (os VIP), a maioria pede de vez em quando.
  const weights = contacts.map((_, i) => (i < 12 ? 7 : i < 40 ? 3 : 1));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const weightedContact = (): ContactSeed => {
    let r = rand() * totalWeight;
    for (const [i, w] of weights.entries()) {
      r -= w;
      if (r < 0) return contacts[i]!;
    }
    return contacts.at(-1)!;
  };

  // ---------- Pedidos do histórico (28 dias) ----------
  const orders: OrderRow[] = [];
  const items: Prisma.OrderItemCreateManyInput[] = [];
  const events: Prisma.OrderEventCreateManyInput[] = [];
  const codes = { ifood: 4100, cw: 21000, menu: 1001 };

  const lines = (): Line[] => {
    const result: Line[] = [];
    const pizzas = chance(0.25) ? 2 : 1;
    for (let p = 0; p < pizzas; p++) {
      const pizza = pick(PIZZAS);
      const half = chance(0.25) ? pick(PIZZAS.filter((item) => item.category === pizza.category && item.name !== pizza.name)) : null;
      const border = chance(0.3) ? pick([["Catupiry", 1000], ["Cheddar", 1000]] as const) : null;
      const cents = Math.max(pizza.cents, half?.cents ?? 0) + (border?.[1] ?? 0);
      result.push({
        name: half ? `Pizza grande ½ ${pizza.name} ½ ${half.name}` : `Pizza ${pizza.name} grande`,
        quantity: 1,
        unitCents: cents,
        options: border ? [`1× Borda ${border[0]}`] : [],
        notes: chance(0.12) ? pick(["Sem cebola, por favor", "Bem assada", "Cortar em 12 pedaços"]) : undefined,
      });
    }
    if (chance(0.7)) {
      const drink = pick(DRINKS);
      result.push({ name: drink.name, quantity: chance(0.2) ? 2 : 1, unitCents: drink.cents });
    }
    if (chance(0.2)) {
      const dessert = pick(DESSERTS);
      result.push({ name: dessert.name, quantity: 1, unitCents: dessert.cents });
    }
    return result;
  };

  /** Um pedido com itens e a linha do tempo da plataforma até `status`. */
  const addOrder = (spec: {
    contact: ContactSeed;
    placedAt: Date;
    status: OrderStatus;
    origin: "IFOOD" | "CARDAPIO_WEB" | "MENU";
    lines?: Line[];
    takeout?: boolean;
    conversationId?: string;
    /** Minutos de cada etapa depois do pedido: confirmado, pronto, saiu, entregue. */
    steps?: [number, number, number, number];
    cancelReason?: string;
    scheduledFor?: Date;
    importedAt?: Date;
    extra?: Partial<Omit<Prisma.OrderCreateManyInput, "id" | "placedAt" | "status" | "contactId">>;
    raw?: Record<string, unknown>;
    paymentMethod?: string;
  }): OrderRow => {
    const { contact, placedAt, status, origin } = spec;
    const orderLines = spec.lines ?? lines();
    const subtotal = orderLines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);
    const fee = spec.takeout ? 0 : subtotal >= 12000 ? 0 : (DISTRICTS.find(([d]) => d === contact.district)?.[1] ?? 700);
    const id = uuid7(placedAt);
    const steps = spec.steps ?? [between(1, 4), between(18, 32), between(24, 40), between(45, 70)];
    const reached = ["PLACED", "CONFIRMED", "PREPARING", "READY", "DISPATCHED", "DELIVERED"].indexOf(status);
    const stepAt = (i: number) => new Date(placedAt.getTime() + steps[i]! * MINUTE);
    const dispatched = !spec.takeout && reached >= 4 ? stepAt(2) : null;
    const delivered = reached >= 5 ? stepAt(3) : null;
    const canceledAt = status === "CANCELED" ? new Date(placedAt.getTime() + between(3, 20) * MINUTE) : null;
    const promised = new Date(placedAt.getTime() + (spec.takeout ? 30 : 55) * MINUTE);
    const payment = pick(["CREDIT", "CREDIT", "DEBIT", "PIX", "CASH"] as const);
    const code = origin === "IFOOD" ? String(codes.ifood++) : origin === "CARDAPIO_WEB" ? String(codes.cw++) : String(codes.menu++);
    const address = spec.takeout
      ? null
      : { street: contact.street, number: contact.number, district: contact.district, city: "São Paulo", state: "SP", complement: chance(0.4) ? `ap. ${between(11, 184)}` : null };
    const raw =
      origin === "IFOOD"
        ? {
            orderType: spec.takeout ? "TAKEOUT" : "DELIVERY",
            extraInfo: orderLines.find((line) => line.notes)?.notes ?? null,
            ...(spec.takeout
              ? { takeout: { takeoutDateTime: promised.toISOString() } }
              : { delivery: { deliveryDateTime: promised.toISOString(), deliveredBy: "MERCHANT", pickupCode: String(between(1000, 9999)), observations: chance(0.2) ? "Interfone quebrado, ligar quando chegar" : null } }),
            payments: {
              methods: [
                payment === "CASH"
                  ? { method: "CASH", value: (subtotal + fee) / 100, prepaid: false, cash: { changeFor: Math.ceil((subtotal + fee) / 5000) * 50 } }
                  : { method: payment, value: (subtotal + fee) / 100, prepaid: payment !== "PIX" || chance(0.5), card: payment === "PIX" ? null : { brand: pick(["VISA", "MASTERCARD", "ELO"]) } },
              ],
            },
            ...(chance(0.15) && { benefits: [{ value: 10, sponsorshipValues: [{ name: "IFOOD", value: 10 }, { name: "MERCHANT", value: 0 }] }] }),
          }
        : origin === "CARDAPIO_WEB"
          ? { order_type: spec.takeout ? "takeout" : "delivery", observation: null }
          : {
              source: "menu",
              orderType: spec.takeout ? "TAKEOUT" : "DELIVERY",
              extraInfo: orderLines.find((line) => line.notes)?.notes ?? null,
              ...(spec.takeout ? { takeout: { takeoutDateTime: promised.toISOString() } } : { delivery: { deliveryDateTime: promised.toISOString() } }),
              payment: { method: payment === "CASH" ? "cash" : payment === "PIX" ? "pix_on_delivery" : payment.toLowerCase(), changeForCents: null },
              customerName: contact.name,
            };
    const row: OrderRow = {
      id,
      tenantId,
      contactId: contact.id,
      channelId: origin === "IFOOD" ? ifood.id : origin === "CARDAPIO_WEB" ? cardapioWeb.id : null,
      conversationId: spec.conversationId ?? null,
      externalOrderId: origin === "MENU" ? `demo-menu-${id}` : `demo-${origin.toLowerCase()}-${code}`,
      displayCode: code,
      status,
      subtotal: reais(subtotal),
      deliveryFee: reais(fee),
      total: reais(subtotal + fee),
      deliveryAddress: address ?? undefined,
      placedAt,
      dispatchedAt: dispatched,
      deliveredAt: delivered,
      canceledAt,
      cancellationReason: status === "CANCELED" ? (spec.cancelReason ?? pick(CANCEL_REASONS)) : null,
      importedAt: spec.importedAt ?? null,
      raw: { ...raw, ...spec.raw } as Prisma.InputJsonObject,
      source: origin === "MENU" ? "MENU" : "PLATFORM",
      scheduledFor: spec.scheduledFor ?? null,
      paymentMethod: origin === "MENU" ? (spec.paymentMethod ?? (payment === "PIX" ? "PIX_ON_DELIVERY" : payment)) : null,
      ...spec.extra,
    };
    orders.push(row);
    for (const line of orderLines) {
      items.push({ tenantId, orderId: id, name: line.name, quantity: line.quantity, unitPrice: reais(line.unitCents), notes: line.notes ?? null, options: line.options ?? [], menuItemId: origin === "MENU" ? (menuIds.get(line.name.replace(/^Pizza (.*) grande$/, "$1")) ?? null) : null });
    }
    if (origin !== "MENU") {
      const event = (code: string, at: Date, metadata?: Record<string, unknown>) =>
        events.push({ tenantId, orderId: id, externalEventId: `demo-${code}-${id}`, code, occurredAt: at, metadata: (metadata ?? undefined) as Prisma.InputJsonObject | undefined });
      event("PLACED", placedAt);
      if (status === "CANCELED") event("CANCELLED", canceledAt!, { CANCEL_REASON: row.cancellationReason });
      else {
        if (reached >= 1) event("CONFIRMED", stepAt(0));
        if (reached >= 3 && !(origin === "CARDAPIO_WEB" && chance(0.5))) event("READY_TO_PICKUP", stepAt(1));
        if (dispatched) event("DISPATCHED", dispatched);
        if (delivered) event("CONCLUDED", delivered);
      }
    }
    contact.lastSeenAt = !contact.lastSeenAt || placedAt > contact.lastSeenAt ? placedAt : contact.lastSeenAt;
    return row;
  };

  // Ids dos clientes já agora: os pedidos e as conversas apontam para eles.
  for (const contact of contacts) contact.id = uuid7(contact.firstSeenAt);

  for (let day = 28; day >= 1; day--) {
    const midnight = brtMidnight(day);
    const weekday = new Date(midnight.getTime() - BRT_OFFSET).getUTCDay();
    const count = (weekday === 5 || weekday === 6 ? 30 : weekday === 0 ? 26 : 18) + between(-3, 4);
    for (let i = 0; i < count; i++) {
      // 30% no almoço (11h-14h), 70% no jantar (18h-23h30).
      const minute = chance(0.3) ? between(11 * 60, 14 * 60) : between(18 * 60, 23 * 60 + 30);
      const status: OrderStatus = chance(0.05) ? "CANCELED" : "DELIVERED";
      addOrder({
        contact: weightedContact(),
        placedAt: new Date(midnight.getTime() + minute * MINUTE + between(0, 59) * 1000),
        status,
        origin: pick(["IFOOD", "IFOOD", "IFOOD", "CARDAPIO_WEB", "MENU", "MENU"] as const),
        takeout: chance(0.1),
      });
    }
  }
  // Clientes antigos (pedidos importados do histórico do Cardápio Web, há 70 a 200 dias): viram "Sumido".
  for (const contact of contacts.slice(95, 110)) {
    for (let k = 0; k < between(1, 3); k++) {
      addOrder({ contact, placedAt: new Date(brtMidnight(between(70, 200)).getTime() + between(19, 22) * 60 * MINUTE), status: "DELIVERED", origin: "CARDAPIO_WEB", importedAt: brtMidnight(60) });
    }
  }

  // ---------- Conversas ----------
  const conversations: Prisma.ConversationCreateManyInput[] = [];
  const messages: MessageRow[] = [];
  const evaluations: Prisma.ConversationEvaluationCreateManyInput[] = [];
  const aiOnly: Prisma.AiOnlyAttendanceCreateManyInput[] = [];
  const ratings: Prisma.RatingCreateManyInput[] = [];
  const identities = new Map<string, Prisma.ContactIdentityCreateManyInput>();

  // Um perfil por canal e cadastro; o mesmo id de canal nunca em dois cadastros (o duplicado de propósito fica sem o WhatsApp).
  const usedExternal = new Set<string>();
  const identityOf = (contact: ContactSeed, type: ChannelType): string => {
    const externalId =
      type === "WHATSAPP" ? contact.phone.slice(1) : type === "INSTAGRAM" ? `demo-igsid-${contact.id.slice(-12)}` : `demo-ifood-${contact.id.slice(-12)}`;
    const keyOf = `${contact.id}:${type}`;
    if (!identities.has(keyOf) && !usedExternal.has(`${type}:${externalId}`)) {
      usedExternal.add(`${type}:${externalId}`);
      identities.set(keyOf, {
        tenantId,
        contactId: contact.id,
        channelType: type,
        externalId,
        profile: type === "INSTAGRAM" ? { username: contact.instagram ?? contact.name.split(" ")[0]!.toLowerCase() } : type === "WHATSAPP" ? { name: contact.name } : {},
      });
    }
    return externalId;
  };

  type Step =
    | ["in", string]
    | ["ai", string]
    | ["auto", string, string]
    | ["team", DemoUserKey, string, Record<string, unknown>?]
    | ["phone", string]
    | ["note", DemoUserKey, string]
    | ["event", string, string, Record<string, unknown>?]
    | ["order", string]
    | ["media", "AUDIO" | "LOCATION" | "IMAGE", Record<string, unknown>];

  /** Grava a conversa e as mensagens, uma a cada `gap` minutos a partir de `start`. Devolve o horário da última. */
  const addConversation = (spec: {
    contact: ContactSeed;
    channel: { id: string; type: ChannelType };
    start: Date;
    steps: Step[];
    gaps?: number[];
    status: "OPEN" | "PENDING" | "RESOLVED";
    assigned?: DemoUserKey;
    extra?: Partial<Prisma.ConversationCreateManyInput>;
    /** Últimas mensagens do cliente ainda não lidas. */
    unread?: number;
  }): { id: string; last: Date; replier: DemoUserKey | null } => {
    const id = uuid7(spec.start);
    const from = identityOf(spec.contact, spec.channel.type);
    let at = spec.start;
    let lastInbound: Date | null = null;
    let replier: DemoUserKey | null = null;
    let teamInvolved = false;
    for (const [index, step] of spec.steps.entries()) {
      if (index > 0) at = new Date(at.getTime() + (spec.gaps?.[index - 1] ?? 1) * MINUTE + between(0, 40) * 1000);
      const base = { tenantId, conversationId: id, channelId: spec.channel.id, createdAt: at };
      const [kind] = step;
      if (kind === "in") {
        lastInbound = at;
        messages.push({ ...base, direction: "INBOUND", type: "TEXT", status: "DELIVERED", content: { text: step[1], from } });
      } else if (kind === "ai") {
        messages.push({ ...base, direction: "OUTBOUND", type: "TEXT", status: "READ", content: { text: step[1], aiReply: true } });
      } else if (kind === "auto") {
        messages.push({ ...base, direction: "OUTBOUND", type: "TEXT", status: "READ", content: { text: step[2], automation: step[1] } as Prisma.InputJsonObject });
      } else if (kind === "team") {
        teamInvolved = true;
        replier = step[1];
        messages.push({ ...base, direction: "OUTBOUND", type: "TEXT", status: "READ", sentByUserId: users[step[1]], content: { text: step[2], ...step[3] } as Prisma.InputJsonObject });
      } else if (kind === "phone") {
        teamInvolved = true;
        messages.push({ ...base, direction: "OUTBOUND", type: "TEXT", status: "READ", content: { text: step[1], fromPhone: true } });
      } else if (kind === "note") {
        teamInvolved = true;
        messages.push({ ...base, direction: "INTERNAL", type: "NOTE", sentByUserId: users[step[1]], content: { text: step[2] } });
      } else if (kind === "event") {
        messages.push({ ...base, direction: "INTERNAL", type: "SYSTEM", content: { event: step[1], text: step[2], ...step[3] } as Prisma.InputJsonObject });
      } else if (kind === "order") {
        messages.push({ ...base, direction: "INTERNAL", type: "SYSTEM", content: { event: "order", orderId: step[1] } });
      } else {
        lastInbound = at;
        messages.push({ ...base, direction: "INBOUND", type: step[1], status: "DELIVERED", content: { ...step[2], from } as Prisma.InputJsonObject });
      }
    }
    conversations.push({
      id,
      tenantId,
      contactId: spec.contact.id,
      channelId: spec.channel.id,
      status: spec.status,
      assignedUserId: spec.assigned ? users[spec.assigned] : null,
      lastMessageAt: at,
      windowExpiresAt: lastInbound && spec.channel.type !== "IFOOD" ? new Date(lastInbound.getTime() + DAY) : null,
      teamInvolved: spec.status !== "RESOLVED" && teamInvolved,
      unreadCount: spec.unread ?? 0,
      createdAt: spec.start,
      ...spec.extra,
    });
    if (!spec.contact.lastSeenAt || at > spec.contact.lastSeenAt) spec.contact.lastSeenAt = at;
    return { id, last: at, replier };
  };

  const first = (contact: ContactSeed) => contact.name.split(" ")[0]!;

  // Roteiros do histórico, por assunto. Sempre começam pelo cliente; "team" pede a passagem antes.
  type Script = { subject: string; team: boolean; teamReason?: string; steps: (c: ContactSeed, o: OrderRow | null) => Step[] };
  const SCRIPTS: Script[] = [
    {
      subject: "andamento_pedido",
      team: false,
      steps: (c, o) => [
        ["in", pick(["boa noite, meu pedido já saiu?", "Oi, qual a previsão do meu pedido?", "oii, meu pedido ta demorando?", "Boa noite! Quanto tempo falta pro meu pedido?"])],
        ...(o ? ([["order", o.id]] as Step[]) : []),
        ["ai", `Oi, ${first(c)}! Seu pedido #${o?.displayCode ?? "4821"} já está ${pick(["saindo do forno", "com o entregador", "na finalização"])}. A previsão é chegar em uns ${between(10, 25)} minutos. 🍕`],
        ["in", pick(["ah otimo, obrigado!", "show, valeu", "perfeito, obrigada", "beleza 👍"])],
        ["ai", "Imagina! Qualquer coisa é só chamar. Bom apetite!"],
      ],
    },
    {
      subject: "andamento_pedido",
      team: true,
      teamReason: "atraso",
      steps: (c, o) => [
        ["in", pick(["Moço já faz mais de uma hora que pedi", "cadê meu pedido??? ja passou do horario", "meu pedido ainda nao chegou, ja era pra ter chegado faz tempo"])],
        ...(o ? ([["order", o.id]] as Step[]) : []),
        ["ai", `Sinto muito pela demora, ${first(c)}. Vou chamar alguém da equipe para ver com o entregador agora mesmo.`],
        ["event", "handoff", "IA passou o atendimento para a equipe: cliente reclamando de atraso"],
        ["team", pick(["julia", "rafael"] as const), `${first(c)}, falei com o entregador: ele está a 5 minutos daí. Desculpa mesmo pela espera, coloquei um petit gâteau de cortesia no seu próximo pedido.`],
        ["in", pick(["ok, obrigado pelo retorno", "tá bom, aguardo", "chegou agora, obrigada"])],
      ],
    },
    {
      subject: "pedido_novo",
      team: false,
      steps: (c) => [
        ["in", pick(["Oi! Queria fazer um pedido", "boa noite, da pra pedir por aqui?", "quero uma pizza grande de calabresa"])],
        ["auto", "order_links", `Oi, ${first(c)}! Que bom te ver por aqui. 🍕 Para pedir é só escolher:\n• Cardápio e pedido online: https://www.dishdesk.com.br/c/${DEMO_SLUG}\n• iFood: https://www.ifood.com.br/`],
        ["in", pick(["pedi pelo site, obrigado!", "Feito! valeu", "obrigada!"])],
      ],
    },
    {
      subject: "problema_pedido",
      team: true,
      teamReason: "problema_pedido",
      steps: (c, o) => [
        ["in", pick(["A pizza veio errada, pedi calabresa e veio portuguesa", "veio faltando o refrigerante do meu pedido", "a pizza chegou fria e meio amassada 😕"])],
        ...(o ? ([["order", o.id]] as Step[]) : []),
        ["ai", `Poxa, ${first(c)}, sinto muito por isso. Já estou chamando a equipe para resolver com você.`],
        ["event", "handoff", "IA passou o atendimento para a equipe: problema no pedido"],
        ["team", pick(["julia", "rafael", "admin"] as const), pick([
          "Peço desculpas pelo erro! Já estou mandando o item certo, chega em até 30 minutos, sem custo nenhum.",
          "Que chato isso, desculpa! Vou estornar o valor do refrigerante e mandar um de cortesia no próximo pedido.",
        ])],
        ["in", pick(["tudo bem, obrigado por resolver rápido", "ok, fico no aguardo", "valeu pela atenção"])],
      ],
    },
    {
      subject: "cardapio",
      team: false,
      steps: () => [
        ["in", pick(["Vocês fazem meio a meio?", "tem pizza sem lactose?", "qual o tamanho da pizza grande?", "Tem opção vegetariana?"])],
        ["ai", pick([
          "Fazemos sim! Todas as salgadas podem ser meio a meio, e vale o preço da metade mais cara. 😊",
          "A grande tem 35 cm e 8 fatias, serve bem 3 pessoas.",
          "Temos a Margherita e a Quatro Queijos, que são vegetarianas. As duas saem também em broto!",
        ])],
        ["in", pick(["ah que bom, vou pedir então", "obrigada!", "show"])],
      ],
    },
    {
      subject: "informacoes",
      team: false,
      steps: () => [
        ["in", pick(["Até que horas vocês entregam?", "entrega no Jabaquara?", "Qual a taxa de entrega pra Moema?"])],
        ["ai", pick([
          "Entregamos todos os dias até 1h da manhã! 🛵",
          "Entregamos sim! No Jabaquara a taxa é R$ 9,00, e acima de R$ 120 a entrega é grátis.",
          "Para Moema a taxa é R$ 6,00. Pedidos acima de R$ 120 não pagam entrega.",
        ])],
        ["in", "perfeito, obrigado"],
      ],
    },
    {
      subject: "pagamento",
      team: true,
      teamReason: "outro",
      steps: () => [
        ["in", "Paguei duas vezes no pix sem querer, como faço pra estornar?"],
        ["ai", "Entendi! Vou passar para a equipe conferir os pagamentos e fazer a devolução."],
        ["event", "handoff", "IA passou o atendimento para a equipe: pagamento em duplicidade"],
        ["team", "admin", "Conferi aqui e realmente entrou duas vezes. Já fiz a devolução de um dos Pix, deve cair em alguns minutos."],
        ["in", "caiu aqui, muito obrigada!"],
      ],
    },
    {
      subject: "elogio",
      team: false,
      steps: () => [
        ["in", pick(["A pizza de hoje estava maravilhosa!! parabéns", "melhor pizza da região, sério", "Chegou quentinha e muito bem embalada, amamos ❤️"])],
        ["ai", "Que alegria ler isso! Vou passar seu recado para a cozinha. Obrigado pelo carinho! ❤️"],
      ],
    },
    {
      subject: "pedido_novo",
      team: true,
      teamReason: "pedido_grande",
      steps: () => [
        ["in", "Boa tarde! Vou fazer um aniversário sábado, dá pra encomendar 10 pizzas pra entregar às 20h?"],
        ["ai", "Que legal! Para encomendas grandes vou chamar a equipe, que combina os detalhes com você."],
        ["event", "handoff", "IA passou o atendimento para a equipe: pedido grande ou evento"],
        ["team", "admin", "Oi! Conseguimos sim. Para 10 pizzas fazemos 10% de desconto e a entrega é grátis. Me passa os sabores?"],
        ["in", "Maravilha! 4 calabresa, 3 frango com catupiry e 3 quatro queijos"],
        ["team", "admin", "Anotado! Fica agendado para sábado às 20h. Vou te mandar o resumo e a chave Pix."],
      ],
    },
  ];
  // Avaliações → Quem resolveu (7 dias, com o dia de hoje) perto de 45% resolvidos só pela IA, a média que a demo mostra
  // (23/11/2026): 39% dos roteiros do histórico são sem "team", porque as conversas de hoje puxam a conta para cima.
  const SUBJECT_WEIGHTS = [0.124, 0.236, 0.085, 0.197, 0.073, 0.057, 0.079, 0.051, 0.098];

  for (let day = 28; day >= 1; day--) {
    const dayOrders = orders.filter((order) => !order.importedAt && order.placedAt >= brtMidnight(day) && order.placedAt < brtMidnight(day - 1));
    const count = between(7, 11);
    for (let i = 0; i < count; i++) {
      let r = rand();
      let script = SCRIPTS[0]!;
      for (const [index, weight] of SUBJECT_WEIGHTS.entries()) {
        r -= weight;
        if (r < 0) {
          script = SCRIPTS[index]!;
          break;
        }
      }
      const needsOrder = ["andamento_pedido", "problema_pedido"].includes(script.subject) && dayOrders.length > 0;
      const order = needsOrder ? pick(dayOrders) : null;
      const contact = order ? contacts.find((c) => c.id === order.contactId)! : weightedContact();
      const start = order
        ? new Date(order.placedAt.getTime() + between(30, 60) * MINUTE)
        : new Date(brtMidnight(day).getTime() + between(11 * 60, 23 * 60) * MINUTE);
      const viaInstagram = contact.instagram && chance(0.5);
      const steps = script.steps(contact, order);
      const gaps = steps.map(() => between(1, 4));
      const conversation = addConversation({
        contact,
        channel: viaInstagram ? instagram : whatsapp,
        start,
        steps,
        gaps,
        status: "RESOLVED",
        assigned: script.team ? (steps.find((s): s is ["team", DemoUserKey, string] => s[0] === "team")?.[1] ?? undefined) : undefined,
      });
      if (order && !order.conversationId) order.conversationId = conversation.id;
      const evaluatedAt = new Date(conversation.last.getTime() + 2 * MINUTE);
      if (script.team) {
        const low = chance(0.12);
        const issue = low ? pick(["demora", "sem_solucao", "informacao_errada"]) : chance(0.1) ? "demora" : null;
        evaluations.push({
          tenantId,
          conversationId: conversation.id,
          userId: conversation.replier ? users[conversation.replier] : null,
          resolved: !low || chance(0.4),
          satisfied: low ? false : chance(0.8) ? true : null,
          score: low ? between(22, 40) : between(72, 98),
          subject: script.subject,
          teamReason: script.teamReason ?? "outro",
          issue,
          fault: issue ? (script.subject === "problema_pedido" || script.teamReason === "atraso" ? "operacao" : "atendimento") : null,
          churnRisk: low ? 0.5 + rand() * 0.4 : rand() * 0.3,
          model: "jev",
          createdAt: evaluatedAt,
        });
        if (low && !contact.tags.includes("Em recuperação")) contact.tags.push("Em recuperação");
      } else {
        aiOnly.push({ tenantId, conversationId: conversation.id, handedOff: false, createdAt: evaluatedAt });
      }
      if (chance(0.45)) {
        const score = pick([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4, 3, 2]);
        ratings.push({ tenantId, conversationId: conversation.id, orderId: order?.id ?? null, score, channelType: viaInstagram ? "INSTAGRAM" : "WHATSAPP", createdAt: evaluatedAt });
        if (score <= 2) contact.tags.push("Insatisfeito");
      }
    }
  }
  // Atendimentos em que a equipe foi chamada fora do horário e ninguém respondeu (aparecem como "sem resposta").
  for (const day of [3, 6, 11]) {
    const contact = pick(contacts.slice(40, 90));
    const conversation = addConversation({
      contact,
      channel: whatsapp,
      start: new Date(brtMidnight(day).getTime() + (60 + between(0, 50)) * MINUTE),
      steps: [
        ["in", "Oi, vocês ainda estão abertos?"],
        ["auto", "after_hours", "Oi! A Vila Brasa está fechada agora 🍕 Abrimos todos os dias às 10h. Sua mensagem fica aqui e a gente responde assim que abrir."],
        ["event", "awaiting_agent", "Restaurante fechado: a conversa espera a equipe", { waitingReason: "closed" }],
      ],
      status: "RESOLVED",
    });
    aiOnly.push({ tenantId, conversationId: conversation.id, handedOff: true, createdAt: new Date(conversation.last.getTime() + 60 * MINUTE) });
  }

  // ---------- Hoje ----------
  // Pedidos e conversas a poucos minutos de agora: a demo abre com a casa cheia, seja qual for a hora.
  const todayStart = Math.min(minutesSinceMidnight, 240);
  const todayOrders: OrderRow[] = [];
  const today = (minutes: number) => ago(Math.min(minutes, todayStart));
  const todayOrder = (spec: Parameters<typeof addOrder>[0]) => {
    const order = addOrder(spec);
    todayOrders.push(order);
    return order;
  };
  const c = (i: number) => contacts[i]!;

  // Pedidos entregues hoje (o movimento do dia).
  for (let i = 0; i < 14; i++) {
    todayOrder({ contact: c(40 + i), placedAt: today(between(70, 230)), status: "DELIVERED", origin: pick(["IFOOD", "IFOOD", "CARDAPIO_WEB", "MENU"] as const), steps: [2, 22, 28, between(40, 55)] });
  }
  todayOrder({ contact: c(55), placedAt: today(95), status: "CANCELED", origin: "IFOOD", cancelReason: "Cliente desistiu do pedido" });

  // Em produção e prontos.
  const placedNow = todayOrder({ contact: c(60), placedAt: ago(1), status: "PLACED", origin: "IFOOD" });
  todayOrder({ contact: c(61), placedAt: ago(3), status: "PLACED", origin: "CARDAPIO_WEB" });
  todayOrder({ contact: c(62), placedAt: ago(6), status: "CONFIRMED", origin: "MENU", paymentMethod: "CREDIT" });
  todayOrder({ contact: c(63), placedAt: ago(9), status: "CONFIRMED", origin: "IFOOD" });
  todayOrder({ contact: c(64), placedAt: ago(14), status: "PREPARING", origin: "IFOOD" });
  const lateOrder = todayOrder({ contact: c(2), placedAt: ago(58), status: "PREPARING", origin: "IFOOD", steps: [3, 90, 95, 120] });
  todayOrder({ contact: c(65), placedAt: ago(21), status: "PREPARING", origin: "CARDAPIO_WEB" });
  todayOrder({ contact: c(66), placedAt: ago(26), status: "READY", origin: "IFOOD", takeout: true, steps: [2, 22, 60, 70] });
  todayOrder({ contact: c(67), placedAt: ago(30), status: "READY", origin: "MENU", steps: [2, 26, 60, 70] });
  todayOrder({ contact: c(68), placedAt: ago(45), status: "CONFIRMED", origin: "MENU", scheduledFor: new Date(now.getTime() + 90 * MINUTE), paymentMethod: "CASH" });

  // Saíram para entrega: dois com entregadores em rota (conversas abaixo).
  const routeA = todayOrder({ contact: c(5), placedAt: ago(38), status: "DISPATCHED", origin: "IFOOD", steps: [2, 20, 26, 60] });
  const routeB = todayOrder({ contact: c(70), placedAt: ago(33), status: "DISPATCHED", origin: "IFOOD", steps: [2, 19, 24, 60] });
  todayOrder({ contact: c(71), placedAt: ago(41), status: "DISPATCHED", origin: "CARDAPIO_WEB", steps: [2, 21, 28, 60] });
  const waitingCustomer = todayOrder({ contact: c(8), placedAt: ago(48), status: "DISPATCHED", origin: "IFOOD", steps: [2, 24, 30, 70] });

  // Negociação aberta no iFood: o cliente pediu o cancelamento e a loja decide.
  const disputeOrder = todayOrder({ contact: c(72), placedAt: ago(36), status: "PREPARING", origin: "IFOOD" });
  events.push({
    tenantId,
    orderId: disputeOrder.id,
    externalEventId: `demo-HANDSHAKE_DISPUTE-${disputeOrder.id}`,
    code: "HANDSHAKE_DISPUTE",
    occurredAt: ago(4),
    metadata: {
      id: `demo-dispute-${disputeOrder.id}`,
      action: "CANCELLATION",
      message: "Pedi sem querer no endereço do trabalho, posso cancelar?",
      expiresAt: new Date(now.getTime() + 11 * MINUTE).toISOString(),
      timeoutAction: "ACCEPT_CANCELLATION",
      acceptCancellationReasons: ["HIGH_STORE_DEMAND", "UNAVAILABLE_ITEM"],
    },
  });

  // Alerta de fraude: endereço com cancelamentos recentes, à espera da decisão da equipe.
  const fraudContact = c(90);
  for (const days of [4, 9, 15]) {
    addOrder({ contact: fraudContact, placedAt: new Date(brtMidnight(days).getTime() + 21 * 60 * MINUTE), status: "CANCELED", origin: "IFOOD", cancelReason: "Cliente não encontrado no endereço" });
  }
  const fraudOrder = todayOrder({
    contact: fraudContact,
    placedAt: ago(7),
    status: "CONFIRMED",
    origin: "IFOOD",
    lines: [{ name: "Pizza Brasa da Casa grande", quantity: 3, unitCents: 7290 }, { name: "Coca-Cola 2 L", quantity: 2, unitCents: 1400 }],
    extra: { alertAt: ago(7), alertAnalysis: { risk: 0.82, verdict: "high" } },
  });
  fraudContact.tags.push("Cancelamento recorrente");

  // ---------- Conversas de hoje: um exemplo de cada estado da Inbox ----------
  const todayConversations: string[] = [];
  const live = (spec: Parameters<typeof addConversation>[0]) => {
    const conversation = addConversation(spec);
    todayConversations.push(conversation.id);
    return conversation;
  };
  const link = (order: OrderRow, conversationId: string) => {
    order.conversationId = conversationId;
  };

  // 1. "Cadê meu pedido?" com atraso de verdade: a IA chamou a equipe e o alarme toca.
  const late = live({
    contact: c(2),
    channel: whatsapp,
    start: ago(9),
    gaps: [0, 1, 1, 3, 1],
    steps: [
      ["in", "Boa noite, cadê meu pedido? Já faz quase uma hora"],
      ["order", lateOrder.id],
      ["ai", `Oi, ${first(c(2))}! Seu pedido #${lateOrder.displayCode} ainda está na cozinha e já passou da previsão. Sinto muito pela demora. Vou chamar alguém da equipe para ver isso agora.`],
      ["event", "handoff", "IA passou o atendimento para a equipe: cliente reclamando de atraso"],
      ["in", "Por favor, tenho criança com fome aqui 😩"],
      ["in", "alguém??"],
    ],
    status: "OPEN",
    unread: 2,
    extra: { awaitingAgentSince: ago(5) },
  });
  link(lateOrder, late.id);

  // 2. Reclamação em atendimento: atribuída, com nota interna e resposta da equipe revisada pela IA.
  const coldOrder = todayOrder({
    contact: c(3),
    placedAt: today(80),
    status: "DELIVERED",
    origin: "MENU",
    lines: [{ name: "Pizza Calabresa grande", quantity: 1, unitCents: 6990, options: ["1× Borda Catupiry"] }],
    steps: [2, 22, 28, 50],
  });
  const complaint = live({
    contact: c(3),
    channel: whatsapp,
    start: ago(26),
    gaps: [0, 1, 1, 2, 3, 2, 4],
    steps: [
      ["in", "A pizza chegou fria e a borda veio sem recheio. Paguei R$ 72 nisso"],
      ["order", coldOrder.id],
      ["ai", `Poxa, ${first(c(3))}, sinto muito! Pizza fria não é o que a gente quer entregar. Vou chamar a equipe para resolver com você.`],
      ["event", "handoff", "IA passou o atendimento para a equipe: problema no pedido"],
      ["note", "admin", "Conferi com a cozinha: a borda de catupiry acabou às 19h e não avisaram. Mandar outra pizza sem custo."],
      ["team", "julia", "Oi! Peço desculpas, você tem toda a razão. Já estamos assando outra pizza com a borda certa, sem custo nenhum, chega em até 30 minutos.", { aiReview: "rewritten", original: "desculpa, ja to mandando outra" }],
      ["in", "Tá bom, obrigado pela atenção. Vou aguardar"],
      ["team", "julia", "Combinado! Te aviso assim que sair daqui. 🙏", { aiReview: "kept" }],
    ],
    status: "OPEN",
    assigned: "julia",
  });

  // 3. Automáticos: a IA está atendendo sozinha uma dúvida de cardápio.
  live({
    contact: c(10),
    channel: instagram,
    start: ago(4),
    gaps: [0, 1, 1],
    steps: [
      ["in", "oii vcs tem pizza sem lactose?"],
      ["ai", "Oi! Temos a Margherita com muçarela sem lactose, é só pedir na observação. As outras levam queijo comum. 😊"],
      ["in", "e a borda? pode ser sem lactose tbm?"],
      ["ai", "A borda recheada infelizmente não tem versão sem lactose. Recomendo a borda tradicional, que é só massa!"],
    ],
    status: "OPEN",
  });

  // 4. Agente de pedidos montando o pedido pela conversa (carrinho da IA).
  const cartChat = live({
    contact: c(11),
    channel: whatsapp,
    start: ago(7),
    gaps: [0, 1, 1, 1, 1],
    steps: [
      ["in", "Quero uma grande meio calabresa meio frango com catupiry"],
      ["event", "menu_agent", "Adicionou: Pizza grande ½ Calabresa ½ Frango com Catupiry"],
      ["ai", "Anotado! Uma grande meio Calabresa, meio Frango com Catupiry, R$ 62,90. Quer acrescentar borda recheada ou um refrigerante? O Combo Família sai mais em conta se for com 2 L."],
      ["in", "coloca uma coca 2l"],
      ["ai", "A Coca-Cola 2 L acabou por hoje 😕 Posso colocar um Guaraná Antarctica 2 L no lugar?"],
      ["in", "pode ser"],
      ["event", "menu_agent", "Adicionou: Guaraná Antarctica 2 L"],
      ["ai", "Prontinho! Pizza + Guaraná 2 L = R$ 74,90, com entrega na Rua das Begônias. Posso confirmar o pedido? Pagamento na entrega: dinheiro, cartão ou Pix na maquininha."],
    ],
    status: "OPEN",
    unread: 0,
  });

  // 5. Aguardando o cliente (pendente): a equipe pediu a confirmação do endereço.
  live({
    contact: c(12),
    channel: whatsapp,
    start: ago(31),
    gaps: [0, 2, 3],
    steps: [
      ["in", "Fiz o pedido mas coloquei o número errado do prédio"],
      ["event", "handoff", "IA passou o atendimento para a equipe: alteração de endereço"],
      ["team", "rafael", "Sem problemas! Qual é o número certo e o apartamento? Já aviso o entregador."],
    ],
    status: "PENDING",
    assigned: "rafael",
  });

  // 6. Mensagem nova agora, não lida (a primeira do dia deste cliente).
  live({
    contact: c(13),
    channel: whatsapp,
    start: ago(1),
    steps: [["in", "Boa noite! Vocês entregam no Ipiranga?"]],
    status: "OPEN",
    unread: 1,
  });

  // 7. Instagram: coleta de telefone em andamento.
  live({
    contact: c(14),
    channel: instagram,
    start: ago(12),
    gaps: [0, 1],
    steps: [
      ["in", "oi, queria saber se vcs fazem pizza broto"],
      ["auto", "phone_collection", `Oi, ${first(c(14))}! 👋 Para a gente não perder seu atendimento caso a conversa caia, pode passar seu telefone com DDD?`],
      ["in", "(11) 90000-0015"],
    ],
    status: "OPEN",
    unread: 1,
    extra: { automationState: { phoneCollection: "awaiting_phone" } },
  });

  // 8. Instagram: cliente não passou o telefone.
  live({
    contact: c(15),
    channel: instagram,
    start: ago(40),
    gaps: [1, 10, 10, 5],
    steps: [
      ["in", "Boa noite"],
      ["auto", "phone_collection", `Oi, ${first(c(15))}! 👋 Para a gente não perder seu atendimento caso a conversa caia, pode passar seu telefone com DDD?`],
      ["auto", "phone_reminder", "Só lembrando: pode passar seu telefone com DDD? 😊"],
      ["event", "phone_pending", "Telefone não informado"],
      ["in", "o refri veio quente"],
    ],
    status: "OPEN",
    unread: 1,
    extra: { automationState: { phoneCollection: "phone_skipped" } },
  });

  // 9. WhatsApp com a janela de 24 h vencida: só dá para responder com template.
  addConversation({
    contact: c(16),
    channel: whatsapp,
    start: ago(26 * 60 + 40),
    gaps: [2],
    steps: [
      ["in", "Vocês fazem pizza para festa? Seria para o próximo sábado"],
      ["ai", "Fazemos sim! A equipe vai te responder com os detalhes. 🍕"],
    ],
    status: "PENDING",
  });

  // 10. Alerta de fraude: conversa só da equipe, aberta pelo alerta do pedido.
  live({
    contact: fraudContact,
    channel: ifood,
    start: ago(7),
    gaps: [0],
    steps: [
      ["order", fraudOrder.id],
      ["event", "fraud_alert", "Alerta de fraude exibido · 3 cancelamentos no endereço nos últimos 15 dias · pedido acima da média"],
    ],
    status: "OPEN",
    extra: { teamOnly: true },
  });

  // 11. Cliente com a tag "Cancelamento recorrente" voltou a escrever.
  live({
    contact: c(91),
    channel: whatsapp,
    start: ago(15),
    gaps: [0, 1],
    steps: [
      ["event", "cancellation_alert", "Cliente com cancelamentos recorrentes: confira o pedido antes de enviar"],
      ["in", "Oi, meu pedido não veio de novo, quero o reembolso"],
      ["ai", "Entendi. Vou chamar a equipe para verificar o que aconteceu com o seu pedido."],
    ],
    status: "OPEN",
    unread: 1,
    extra: { awaitingAgentSince: ago(13) },
  });
  c(91).tags.push("Cancelamento recorrente");

  // 12. A IA acha que quem escreve é um entregador (sem a tag): a equipe confirma.
  live({
    contact: c(92),
    channel: whatsapp,
    start: ago(3),
    gaps: [0],
    steps: [
      ["in", "to na portaria do pedido 4188, cliente nao desce"],
      ["event", "courier_check", "A IA acha que quem escreve é um entregador: a equipe confirma"],
    ],
    status: "OPEN",
    unread: 1,
    extra: { automationState: { courierCheck: { reason: "Fala em portaria e no número de um pedido, como um entregador." } } },
  });

  // ---------- Entregadores ----------
  const couriers: ContactSeed[] = ["Wellington Souza", "Edivaldo Ramos", "Thiago Moraes", "Cleber Antunes", "Josué Pereira"].map((name, i) => ({
    id: uuid7(brtMidnight(120 + i)),
    name,
    phone: `+55119000${String(800 + i).padStart(5, "0")}`,
    district: "Vila Mariana",
    street: pick(STREETS),
    number: String(between(10, 900)),
    instagram: null,
    tags: ["Entregador"],
    firstSeenAt: brtMidnight(120 + i),
    lastSeenAt: null,
  }));
  // Em rota: avisou a saída e chegou no cliente (o card mostra o pedido e o cliente).
  live({
    contact: couriers[0]!,
    channel: whatsapp,
    start: ago(2),
    gaps: [0, 0, 0],
    steps: [
      ["in", `cheguei no ${routeA.displayCode}`],
      ["order", routeA.id],
      ["auto", "courier_arrival", `Avisamos ${first(c(5))} que você chegou com o pedido #${routeA.displayCode}. 👍`],
      ["auto", "courier_arrival_confirmed", "Mensagem entregue ao cliente."],
    ],
    status: "OPEN",
    extra: { automationState: { courierOrderId: routeA.id } },
  });
  live({
    contact: couriers[1]!,
    channel: whatsapp,
    start: ago(11),
    gaps: [0, 1, 0],
    steps: [
      ["in", "boa noite"],
      ["auto", "courier_menu", "Oi, Edivaldo! O que você precisa?\n1 - Avisar que cheguei (iFood)\n2 - Avisar que deixei na portaria (iFood)\n3 - Problema com um pedido\n4 - Outro assunto"],
      ["in", "3"],
      ["auto", "courier_problem_request", "Qual é o número do pedido e o que aconteceu?"],
    ],
    status: "OPEN",
    unread: 0,
    extra: { automationState: { courierOrderId: routeB.id, triage: "awaiting_problem_order" } },
  });
  // Pedido entregue na portaria (resolvido) e outro assunto (aviso discreto, sem alarme).
  addConversation({
    contact: couriers[2]!,
    channel: whatsapp,
    start: ago(95),
    gaps: [0, 0],
    steps: [
      ["in", `deixei na portaria o ${todayOrders[1]!.displayCode}`],
      ["auto", "courier_front_desk", `Avisamos o cliente que o pedido #${todayOrders[1]!.displayCode} ficou na portaria. Obrigado!`],
      ["auto", "courier_front_desk_confirmed", "Mensagem entregue ao cliente."],
    ],
    status: "RESOLVED",
  });
  // O lado do cliente dos dois avisos: o Dish Desk abre o chat do iFood do pedido e manda o aviso no tom da casa
  // (textos da personalidade acolhedor), já resolvido, como faz o courier-menu.service. Só pedido do iFood tem esse chat.
  for (const [order, label, text, minutes] of [
    [routeA, "courier_arrival", "Que notícia boa! 🧡 O entregador nos avisou que já está na sua porta.", 2],
    [todayOrders[1]!, "courier_front_desk", "Seu pedido chegou! 🧡 O entregador deixou ele na portaria. Bom apetite!", 95],
  ] as const) {
    if (order.channelId !== ifood.id) continue;
    const customer = contacts.find((contact) => contact.id === order.contactId)!;
    const chat = live({ contact: customer, channel: ifood, start: ago(minutes), gaps: [0, 0], steps: [["order", order.id], ["auto", label, text]], status: "RESOLVED" });
    if (!order.conversationId) link(order, chat.id);
  }
  live({
    contact: couriers[3]!,
    channel: whatsapp,
    start: ago(6),
    gaps: [0, 1, 0],
    steps: [
      ["in", "4"],
      ["auto", "courier_menu", "Pode escrever o assunto que a equipe já te responde."],
      ["in", "consigo pegar mais uma rota hoje? to livre aqui perto"],
    ],
    status: "OPEN",
    unread: 1,
    extra: { awaitingAgentSince: ago(5), awaitingAgentQuiet: true },
  });
  addConversation({
    contact: couriers[4]!,
    channel: whatsapp,
    start: new Date(brtMidnight(1).getTime() + 22 * 60 * MINUTE),
    gaps: [1],
    steps: [
      ["in", "fechei por hoje, amanha to a partir das 18h"],
      ["phone", "Fechado, Josué! Até amanhã 👊"],
    ],
    status: "RESOLVED",
  });

  // 13. Cliente com pedido em rota pergunta (a previsão sai pelo botão do card).
  const route = live({
    contact: c(8),
    channel: whatsapp,
    start: ago(4),
    gaps: [0, 1],
    steps: [
      ["in", "o motoboy já saiu?"],
      ["order", waitingCustomer.id],
      ["ai", `Saiu sim, ${first(c(8))}! O pedido #${waitingCustomer.displayCode} está a caminho e deve chegar em uns 10 minutos. 🛵`],
    ],
    status: "OPEN",
  });
  link(waitingCustomer, route.id);

  // 14. Áudio com transcrição e localização.
  live({
    contact: c(17),
    channel: whatsapp,
    start: ago(18),
    gaps: [0, 1, 2],
    steps: [
      ["media", "AUDIO", { media: { mimeType: "audio/ogg", seconds: 14, transcription: "Oi, tudo bom? Queria saber se dá pra trocar a Coca do meu pedido por Guaraná, pode ser? Obrigado." } }],
      ["ai", "Pode sim! Troquei a Coca-Cola por um Guaraná Antarctica 2 L no seu pedido. 😊"],
      ["media", "LOCATION", { location: { latitude: -23.5869, longitude: -46.6342, name: "Portão de trás do condomínio" } }],
      ["ai", "Anotado! Vou avisar o entregador para ir pelo portão de trás."],
    ],
    status: "OPEN",
  });

  // 15. Envio que falhou (o atendente pode tentar de novo).
  const failedChat = live({
    contact: c(18),
    channel: whatsapp,
    start: ago(22),
    gaps: [0, 2],
    steps: [
      ["in", "Qual a chave pix de vocês?"],
      ["team", "rafael", "Nossa chave Pix é o CNPJ: 00.000.000/0001-00 (Vila Brasa Pizzaria)."],
    ],
    status: "OPEN",
    assigned: "rafael",
  });
  const lastFailed = messages.findLast((message) => message.conversationId === failedChat.id)!;
  lastFailed.status = "FAILED";
  lastFailed.statusError = "O WhatsApp não entregou: o número do cliente está fora de área há muito tempo.";

  // 16. Funcionário (sem automação nem IA).
  live({
    contact: { ...c(19), id: uuid7(brtMidnight(300)), name: "Seu Antônio (cozinha)", phone: "+5511900009100", tags: ["Funcionário"], instagram: null },
    channel: whatsapp,
    start: ago(16),
    gaps: [0, 2],
    steps: [
      ["in", "Marcelo, acabou a muçarela de búfala, segura a Margherita especial no cardápio"],
      ["team", "admin", "Feito, Seu Antônio! Já marquei como esgotada."],
    ],
    status: "OPEN",
    assigned: "admin",
  });

  // 17. Resposta bloqueada pela revisão da IA (má conduta): virou alerta interno, não saiu.
  live({
    contact: c(20),
    channel: whatsapp,
    start: ago(48),
    gaps: [0, 2, 3, 1],
    steps: [
      ["in", "pela terceira vez veio sem o molho, vcs não prestam atenção?"],
      ["event", "handoff", "IA passou o atendimento para a equipe: reclamação repetida"],
      ["team", "rafael", "Desculpa pelo transtorno! Vou mandar o molho agora com um entregador, sem custo.", { aiReview: "kept" }],
      ["in", "obrigado"],
    ],
    status: "RESOLVED",
    assigned: "rafael",
  });
  // Como a revisão grava: a mensagem vira interna, sem o texto, com o original e o motivo.
  messages.push({
    tenantId,
    conversationId: todayConversations.at(-1)!,
    channelId: whatsapp.id,
    createdAt: ago(46),
    direction: "INTERNAL",
    type: "TEXT",
    status: null,
    sentByUserId: users.rafael,
    content: { aiReview: "blocked", original: "se não gostou pede em outro lugar", misconduct: "Resposta grosseira ao cliente" },
  });

  // 18. Possível duplicado: o telefone informado já está em outro cadastro.
  const duplicateA = c(21);
  const duplicateB: ContactSeed = { ...c(21), id: uuid7(brtMidnight(5)), name: `${first(c(21))} ${c(21).name.split(" ")[1]![0]}.`, instagram: `${first(c(21)).toLowerCase()}_ig`, tags: [] };
  live({
    contact: duplicateB,
    channel: instagram,
    start: ago(20),
    gaps: [0, 1],
    steps: [
      ["in", "oi! meu telefone é 11 90000-0022"],
      ["event", "possible_duplicate", `O telefone informado já está no cadastro de ${duplicateA.name}: confira em Clientes → Duplicados`],
      ["ai", "Obrigado! Já anotei seu telefone. Em que posso ajudar?"],
    ],
    status: "OPEN",
  });

  // 19. Chat do iFood (a loja responde pelo widget do iFood).
  const ifoodChat = live({
    contact: c(64),
    channel: ifood,
    start: ago(10),
    gaps: [0, 1, 2],
    steps: [
      ["order", todayOrders.find((o) => o.contactId === c(64).id)!.id],
      ["in", "Oi, consegue mandar sachê de ketchup?"],
      ["team", "julia", "Claro! Já coloquei no pedido. 😊", { storeReply: true }],
      ["in", "obrigadaaa"],
    ],
    status: "OPEN",
    assigned: "julia",
  });
  link(todayOrders.find((o) => o.contactId === c(64).id)!, ifoodChat.id);

  // 20. Resolvidas hoje: elogio, horário, um pedido pelo link e um "já saiu?" de um pedido entregue.
  for (const [index, script] of [SCRIPTS[7]!, SCRIPTS[5]!, SCRIPTS[2]!, SCRIPTS[0]!].entries()) {
    const order = script.subject === "andamento_pedido" ? (todayOrders.find((o) => o.status === "DELIVERED" && o.contactId === c(40).id) ?? null) : null;
    const contact = order ? c(40) : c(25 + index);
    const conversation = live({ contact, channel: whatsapp, start: today(120 + index * 25), gaps: [1, 2, 1, 1], steps: script.steps(contact, order), status: "RESOLVED" });
    aiOnly.push({ tenantId, conversationId: conversation.id, handedOff: false, createdAt: new Date(conversation.last.getTime() + 2 * MINUTE) });
    if (index === 0) ratings.push({ tenantId, conversationId: conversation.id, score: 5, channelType: "WHATSAPP", createdAt: new Date(conversation.last.getTime() + 3 * MINUTE) });
  }
  // E uma reclamação resolvida hoje pela equipe, já avaliada pela IA.
  const wrongOrder = todayOrder({ contact: c(30), placedAt: today(200), status: "DELIVERED", origin: "IFOOD", steps: [2, 22, 28, 45] });
  const resolvedToday = live({
    contact: c(30),
    channel: whatsapp,
    start: today(140),
    gaps: [0, 1, 1, 3, 2],
    steps: SCRIPTS[3]!.steps(c(30), wrongOrder),
    status: "RESOLVED",
    assigned: "julia",
  });
  evaluations.push({
    tenantId,
    conversationId: resolvedToday.id,
    userId: users.julia,
    resolved: true,
    satisfied: true,
    score: 91,
    subject: "problema_pedido",
    teamReason: "problema_pedido",
    model: "jev",
    churnRisk: 0.12,
    createdAt: new Date(resolvedToday.last.getTime() + 2 * MINUTE),
  });
  link(wrongOrder, resolvedToday.id);
  ratings.push({ tenantId, conversationId: resolvedToday.id, orderId: wrongOrder.id, score: 4, channelType: "WHATSAPP", createdAt: new Date(resolvedToday.last.getTime() + 3 * MINUTE) });

  // 21. Pedidos pela IA que pararam no meio (tela Carrinhos abandonados): o cliente sumiu antes de confirmar.
  const stalled: { conversationId: string; contactId: string; at: Date; pix: boolean }[] = [];
  for (const [index, minutes] of [45, 130, 300, 26 * 60].entries()) {
    const contact = c(31 + index);
    const conversation = addConversation({
      contact,
      channel: whatsapp,
      start: ago(minutes + 6),
      gaps: [1, 0, 1, 2],
      steps: [
        ["in", pick(["quero uma pizza grande de calabresa", "me vê uma quatro queijos grande", "uma portuguesa grande e um guaraná"])],
        ["event", "menu_agent", "Adicionou ao carrinho"],
        ["ai", "Anotado! Quer acrescentar uma borda recheada ou um refrigerante?"],
        ["in", "pode fechar assim"],
        ["ai", index === 2 ? "Prontinho! Gerei o Pix de R$ 64,90, válido por 15 minutos. É só copiar o código e pagar no app do banco." : "Fechado! Posso confirmar o pedido? Pagamento na entrega: dinheiro, cartão ou Pix na maquininha."],
      ],
      status: "RESOLVED",
    });
    stalled.push({ conversationId: conversation.id, contactId: contact.id, at: conversation.last, pix: index === 2 });
  }

  // ---------- Tags, identidades e gravação ----------
  const allContacts = [...contacts, ...couriers, duplicateB, ...conversationsContactsExtra(conversations, contacts, couriers, duplicateB)];
  const ordersBy = new Map<string, OrderRow[]>();
  for (const order of orders) if (order.status !== "CANCELED") ordersBy.set(order.contactId, [...(ordersBy.get(order.contactId) ?? []), order]);
  const ranked = [...ordersBy.entries()].filter(([, list]) => list.length >= 2).sort((a, b) => b[1].length - a[1].length);
  const vip = new Set(ranked.slice(0, Math.floor(contacts.length * 0.1)).map(([id]) => id));
  for (const contact of allContacts) {
    if (contact.tags.includes("Entregador") || contact.tags.includes("Funcionário")) continue;
    const list = ordersBy.get(contact.id) ?? [];
    const lastOrder = list.reduce<Date | null>((max, o) => (!max || o.placedAt > max ? o.placedAt : max), null);
    const firstOrder = list.reduce<Date | null>((min, o) => (!min || o.placedAt < min ? o.placedAt : min), null);
    const tags = new Set(contact.tags);
    if (vip.has(contact.id)) tags.add("VIP");
    if (list.filter((o) => o.placedAt > brtMidnight(90)).length >= 3) tags.add("Recorrente");
    if (firstOrder && firstOrder > brtMidnight(30) && list.length <= 2) tags.add("Novo");
    if (lastOrder && lastOrder < brtMidnight(60)) tags.add("Sumido");
    if (tags.has("Em recuperação") && lastOrder && contact.lastSeenAt && lastOrder >= contact.lastSeenAt) tags.delete("Em recuperação");
    contact.tags = [...tags];
    if (firstOrder && firstOrder < contact.firstSeenAt) contact.firstSeenAt = firstOrder;
  }

  await tx.contact.createMany({
    data: allContacts.map((contact) => ({
      id: contact.id,
      tenantId,
      name: contact.name,
      phone: contact.phone,
      phoneSource: "channel",
      phoneStatus: "ok",
      email: contact.tags.includes("VIP") ? `${contact.name.split(" ")[0]!.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")}.${contact.phone.slice(-3)}@example.com` : null,
      tags: contact.tags,
      notes: contact.tags.includes("VIP") ? "Prefere a pizza bem assada. Aniversário em março." : null,
      firstSeenAt: contact.firstSeenAt,
      lastSeenAt: contact.lastSeenAt,
      // CPF fictício (gerado, válido no formato) só nos VIP, para a tela de LGPD mostrar o mascaramento.
      ...(contact.tags.includes("VIP") && { cpfEncrypted: encrypt(fakeCpf(contact.phone), key), cpfHash: blindIndex(fakeCpf(contact.phone), key) }),
    })),
  });
  await tx.contactAddress.createMany({
    data: allContacts
      .filter((contact) => !contact.tags.includes("Funcionário"))
      .map((contact) => ({ tenantId, contactId: contact.id, label: "Casa", street: contact.street, number: contact.number, district: contact.district, city: "São Paulo", state: "SP", zipCode: "04100-000" })),
  });
  for (const contact of allContacts) {
    if (!contact.tags.includes("Entregador")) identityOf(contact, "WHATSAPP");
    if (ordersBy.get(contact.id)?.some((order) => order.channelId === ifood.id)) identityOf(contact, "IFOOD");
  }
  await tx.contactIdentity.createMany({ data: [...identities.values()] });
  await tx.consent.createMany({
    data: allContacts.slice(0, 60).map((contact) => ({ tenantId, contactId: contact.id, purpose: "marketing_whatsapp", granted: true, source: "cardapio", createdAt: contact.firstSeenAt })),
  });
  // Par de duplicados que o Jev revisou e mandou para a fila do admin.
  const [pairA, pairB] = [duplicateA.id, duplicateB.id].sort();
  await tx.contactDuplicateReview.create({ data: { tenantId, contactAId: pairA!, contactBId: pairB!, reasons: ["address", "phone"], sameChance: 0.78, model: "jev" } });

  await tx.conversation.createMany({ data: conversations });
  for (let i = 0; i < messages.length; i += 1000) await tx.message.createMany({ data: messages.slice(i, i + 1000) });
  for (let i = 0; i < orders.length; i += 500) await tx.order.createMany({ data: orders.slice(i, i + 500) });
  for (let i = 0; i < items.length; i += 1000) await tx.orderItem.createMany({ data: items.slice(i, i + 1000) });
  for (let i = 0; i < events.length; i += 1000) await tx.orderEvent.createMany({ data: events.slice(i, i + 1000) });
  await tx.conversationEvaluation.createMany({ data: evaluations });
  await tx.aiOnlyAttendance.createMany({ data: aiOnly });
  await tx.rating.createMany({ data: ratings });

  // Convites de avaliação do iFood dos pedidos entregues hoje.
  await tx.reviewInvite.createMany({
    data: todayOrders
      .filter((order) => order.channelId === ifood.id && order.status === "DELIVERED")
      .map((order, i) => ({
        tenantId,
        orderId: order.id,
        status: i % 4 === 3 ? "SKIPPED" : "SENT",
        reason: i % 4 === 3 ? "late" : null,
        text: "Oi! Gostou do pedido? Sua avaliação aqui no iFood ajuda muito a Vila Brasa. ⭐",
        dueAt: new Date(order.deliveredAt ?? now),
        sentAt: i % 4 === 3 ? null : new Date(new Date(order.deliveredAt ?? now).getTime() + 20 * MINUTE),
      })),
  });

  const funnelEvents = await seedFunnelAndCarts(tx, { tenantId, now, rand, brtMidnight, menuIds, cartConversationId: cartChat.id, cartContactId: c(11).id, stalled });

  await tx.menuImportRequest.create({
    data: { tenantId, userId: users.admin, storeName: "Vila Brasa Pizzaria", cnpj: "00000000000100", status: "DONE", note: "Cardápio importado: 17 itens em 5 categorias.", resolvedAt: brtMidnight(20), createdAt: brtMidnight(21) },
  });

  void complaint;
  void placedNow;
  return {
    contacts: allContacts.length,
    couriers: couriers.length,
    conversations: conversations.length,
    conversationsToday: todayConversations.length,
    messages: messages.length,
    orders: orders.length,
    ordersToday: todayOrders.length,
    evaluations: evaluations.length,
    ratings: ratings.length,
    funnelEvents,
  };
}

/** Cadastros que só aparecem numa conversa (o funcionário): entram na lista de clientes a gravar. */
function conversationsContactsExtra(
  conversations: Prisma.ConversationCreateManyInput[],
  contacts: ContactSeed[],
  couriers: ContactSeed[],
  duplicate: ContactSeed,
): ContactSeed[] {
  const known = new Set([...contacts, ...couriers, duplicate].map((contact) => contact.id));
  const extra: ContactSeed[] = [];
  for (const conversation of conversations) {
    if (known.has(conversation.contactId)) continue;
    known.add(conversation.contactId);
    extra.push({
      id: conversation.contactId,
      name: "Seu Antônio (cozinha)",
      phone: "+5511900009100",
      district: "Vila Mariana",
      street: "Rua das Begônias",
      number: "410",
      instagram: null,
      tags: ["Funcionário"],
      firstSeenAt: conversation.createdAt as Date,
      lastSeenAt: conversation.lastMessageAt as Date,
    });
  }
  return extra;
}

/** CPF com dígitos verificadores válidos, montado a partir do telefone fictício (não é de ninguém). */
function fakeCpf(phone: string): string {
  const base = `9${phone.slice(-8)}`.split("").map(Number);
  const digit = (digits: number[]) => {
    const sum = digits.reduce((acc, d, i) => acc + d * (digits.length + 1 - i), 0);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  const d1 = digit(base);
  const d2 = digit([...base, d1]);
  return [...base, d1, d2].join("");
}

// ---------- Cardápio ----------

async function seedMenu(tx: Tx, tenantId: string, now: Date): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const menu = await tx.menu.create({ data: { tenantId, name: "Cardápio Vila Brasa" }, select: { id: true } });
  const group = (name: string, minSelect: number, maxSelect: number, options: [string, number, boolean?][]) =>
    tx.menuOptionGroup.create({
      data: {
        tenantId,
        menuId: menu.id,
        name,
        minSelect,
        maxSelect,
        options: { create: options.map(([option, priceCents, soldOut], sortOrder) => ({ tenantId, name: option, priceCents, sortOrder, soldOut: soldOut ?? false })) },
      },
      select: { id: true },
    });
  const borda = await group("Borda recheada", 0, 1, [["Catupiry", 1000], ["Cheddar", 1000], ["Chocolate", 1200], ["Doce de leite", 1200, true]]);
  const comboDrink = await group("Refrigerante do combo", 1, 1, [["Guaraná 2 L", 0], ["Coca-Cola 2 L", 200]]);
  const extras = await group("Adicionais", 0, 3, [["Bacon", 600], ["Azeitona extra", 300], ["Cebola caramelizada", 500]]);

  const categories = new Map<string, string>();
  const halfOf: Record<string, "MAX" | "AVERAGE" | undefined> = { "Pizzas salgadas": "MAX", "Pizzas doces": "AVERAGE" };
  for (const [sortOrder, name] of ["Pizzas salgadas", "Pizzas doces", "Combos", "Bebidas", "Sobremesas"].entries()) {
    const category = await tx.menuCategory.create({
      data: { tenantId, menuId: menu.id, name, sortOrder, allowsHalf: Boolean(halfOf[name]), halfPricing: halfOf[name] ?? "MAX" },
      select: { id: true },
    });
    categories.set(name, category.id);
  }
  // Pizzas doces só à noite.
  await tx.menuAvailability.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ tenantId, categoryId: categories.get("Pizzas doces")!, weekday, startMinute: 18 * 60, endMinute: 24 * 60 })),
  });
  const details: Record<string, Partial<Prisma.MenuItemUncheckedCreateInput>> = {
    Margherita: { description: "Muçarela de búfala, tomate e manjericão fresco.", ingredients: ["molho de tomate", "muçarela de búfala", "tomate", "manjericão"], allergens: ["lactose", "glúten"], tags: ["vegetariano"], synonyms: ["marguerita", "margarita"] },
    Calabresa: { description: "Calabresa fatiada, cebola roxa e azeitona preta.", ingredients: ["molho de tomate", "muçarela", "calabresa", "cebola", "azeitona"], allergens: ["lactose", "glúten"], tags: ["mais pedido"], synonyms: ["calabreza", "linguiça"], aiNotes: "Dá para pedir sem cebola." },
    Portuguesa: { description: "Presunto, ovo, cebola, ervilha e azeitona.", ingredients: ["presunto", "ovo", "cebola", "ervilha", "azeitona", "muçarela"], allergens: ["lactose", "glúten", "ovo"] },
    "Frango com Catupiry": { description: "Frango desfiado temperado com Catupiry original.", ingredients: ["frango", "catupiry", "milho"], allergens: ["lactose", "glúten"], tags: ["mais pedido"], synonyms: ["frango catupiri"] },
    "Quatro Queijos": { description: "Muçarela, provolone, parmesão e gorgonzola.", ingredients: ["muçarela", "provolone", "parmesão", "gorgonzola"], allergens: ["lactose", "glúten"], tags: ["vegetariano"], synonyms: ["4 queijos"] },
    Pepperoni: { description: "Pepperoni artesanal levemente picante.", ingredients: ["pepperoni", "muçarela", "orégano"], allergens: ["lactose", "glúten"], tags: ["picante"] },
    "Brasa da Casa": { description: "Costela desfiada na brasa, cebola caramelizada e queijo coalho.", ingredients: ["costela", "cebola caramelizada", "queijo coalho"], allergens: ["lactose", "glúten"], tags: ["especial da casa"], aiNotes: "É a pizza assinatura: ofereça para quem pede uma sugestão." },
    "Chocolate com Morango": { ingredients: ["chocolate ao leite", "morango"], allergens: ["lactose", "glúten"], tags: ["doce"] },
    "Romeu e Julieta": { ingredients: ["muçarela", "goiabada"], allergens: ["lactose", "glúten"], tags: ["doce"], synonyms: ["goiabada com queijo"] },
    "Combo Família": { description: "Uma pizza grande salgada e um refrigerante 2 L.", servesPeople: 4, tags: ["promoção"] },
    "Combo Casal": { description: "Uma pizza média salgada, um refrigerante lata e um pudim.", servesPeople: 2, tags: ["promoção"] },
    "Coca-Cola 2 L": { soldOut: true },
    "Petit gâteau": { description: "Com sorvete de creme.", allergens: ["lactose", "glúten", "ovo"] },
  };
  for (const [sortOrder, entry] of MENU.entries()) {
    const item = await tx.menuItem.create({
      data: {
        tenantId,
        categoryId: categories.get(entry.category)!,
        name: entry.name,
        priceCents: entry.sizes ? null : entry.cents,
        sortOrder,
        servesPeople: entry.sizes ? 3 : null,
        ...details[entry.name],
        sizes: entry.sizes && { create: (["Broto", "Média", "Grande"] as const).map((name, i) => ({ tenantId, name, priceCents: entry.sizes![i]!, sortOrder: i })) },
        optionGroups: entry.category === "Pizzas salgadas"
          ? { create: [{ tenantId, groupId: borda.id }, { tenantId, groupId: extras.id, sortOrder: 1 }] }
          : entry.category.startsWith("Combo")
            ? { create: [{ tenantId, groupId: comboDrink.id }] }
            : undefined,
        createdAt: new Date(now.getTime() - 60 * DAY),
      },
      select: { id: true },
    });
    ids.set(entry.name, item.id);
  }
  await tx.menuItemPairing.createMany({
    data: [
      ["Calabresa", "Guaraná Antarctica 2 L"],
      ["Brasa da Casa", "Coca-Cola 2 L"],
      ["Quatro Queijos", "Suco de laranja 500 ml"],
      ["Frango com Catupiry", "Petit gâteau"],
    ].map(([itemId, pairedItemId]) => ({ tenantId, itemId: ids.get(itemId!)!, pairedItemId: ids.get(pairedItemId!)! })),
  });
  return ids;
}

// ---------- Funil e carrinhos ----------

async function seedFunnelAndCarts(
  tx: Tx,
  input: {
    tenantId: string;
    now: Date;
    rand: () => number;
    brtMidnight: (days: number) => Date;
    menuIds: Map<string, string>;
    cartConversationId: string;
    cartContactId: string;
    stalled: { conversationId: string; contactId: string; at: Date; pix: boolean }[];
  },
): Promise<number> {
  const { tenantId, now, rand, brtMidnight, menuIds } = input;
  const stages = ["PAGE_VIEW", "VIEW_CONTENT", "ADD_TO_CART", "INITIATE_CHECKOUT", "ADD_PAYMENT_INFO", "PURCHASE"] as const;
  // Quantos visitantes passam de uma etapa à próxima.
  const keep = [0.72, 0.4, 0.68, 0.85, 0.82];
  const sources = [{ utm_source: "instagram" }, { utm_source: "google" }, { utm_source: "whatsapp" }, {}, { utm_source: "facebook", fbclid: "demo" }];
  const items = [...menuIds.values()];
  const rows: Prisma.FunnelEventCreateManyInput[] = [];
  for (let day = 28; day >= 0; day--) {
    const visitors = 35 + Math.floor(rand() * 30);
    for (let v = 0; v < visitors; v++) {
      const sessionId = `demo-${day}-${v}`;
      const attribution = sources[Math.floor(rand() * sources.length)]!;
      const channel = rand() < 0.25 ? "WHATSAPP" : "WEB";
      let at = new Date(brtMidnight(day).getTime() + (11 * 60 + Math.floor(rand() * 12 * 60)) * MINUTE);
      if (day === 0 && at > now) at = new Date(now.getTime() - Math.floor(rand() * 180) * MINUTE);
      for (const [index, stage] of stages.entries()) {
        if (index > 0 && rand() > keep[index - 1]!) break;
        at = new Date(at.getTime() + Math.floor(rand() * 3 + 1) * MINUTE);
        rows.push({
          tenantId,
          eventId: uuid7(at),
          stage,
          channel,
          sessionId,
          menuItemId: stage === "VIEW_CONTENT" || stage === "ADD_TO_CART" ? items[Math.floor(rand() * items.length)]! : null,
          valueCents: stage === "PURCHASE" || stage === "INITIATE_CHECKOUT" ? 5000 + Math.floor(rand() * 6000) : null,
          attribution,
          capiSentAt: stage === "PURCHASE" ? at : null,
          createdAt: at,
        });
      }
    }
  }
  for (let i = 0; i < rows.length; i += 1000) await tx.funnelEvent.createMany({ data: rows.slice(i, i + 1000) });

  // Carrinhos abandonados (para a tela de recuperação) e o carrinho que a IA monta na conversa de hoje.
  const calabresa = menuIds.get("Calabresa")!;
  const guarana = menuIds.get("Guaraná Antarctica 2 L")!;
  // As pizzas têm o preço no tamanho: o carrinho leva a grande.
  const grande = async (itemId: string) => (await tx.menuItemSize.findFirst({ where: { itemId, name: "Grande" }, select: { id: true } }))?.id ?? null;
  // Carrinhos montados pela IA em conversa e parados: os que a tela de abandonados mostra (um com o Pix vencido).
  for (const [index, { conversationId, contactId, at, pix }] of input.stalled.entries()) {
    const cart = await tx.cart.create({
      data: { tenantId, contactId, conversationId, status: index % 2 ? "AWAITING_CONFIRMATION" : "DRAFT", createdAt: at, updatedAt: at, recoverySentAt: index === 3 ? new Date(at.getTime() + 40 * MINUTE) : null },
      select: { id: true },
    });
    if (pix) {
      await tx.payment.create({
        data: { tenantId, cartId: cart.id, status: "EXPIRED", provider: "demo", txid: `demo-${cart.id}`, amountCents: 6490, expiresAt: new Date(at.getTime() + 15 * MINUTE), createdAt: at },
      });
    }
    await tx.cartItem.createMany({
      data: [
        { tenantId, cartId: cart.id, itemId: items[index % 7]!, sizeId: await grande(items[index % 7]!), quantity: 1 },
        ...(index % 2 === 0 ? [{ tenantId, cartId: cart.id, itemId: menuIds.get("Guaraná Antarctica 2 L")!, quantity: 1 }] : []),
      ],
    });
  }
  const cart = await tx.cart.create({
    data: { tenantId, contactId: input.cartContactId, conversationId: input.cartConversationId, status: "AWAITING_CONFIRMATION", createdAt: new Date(now.getTime() - 6 * MINUTE) },
    select: { id: true },
  });
  await tx.cartItem.createMany({
    data: [
      { tenantId, cartId: cart.id, itemId: calabresa, sizeId: await grande(calabresa), halves: [menuIds.get("Frango com Catupiry")!], quantity: 1 },
      { tenantId, cartId: cart.id, itemId: guarana, quantity: 1 },
    ],
  });
  return rows.length;
}
