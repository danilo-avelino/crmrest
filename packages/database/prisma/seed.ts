// Dados de demonstração inspirados no design (CRM Restaurantes.html). Recria tudo a cada execução.
// Uso: pnpm db:seed — login: ana.silva@cantinadanonna.com.br / comanda123
import { existsSync } from "node:fs";
import { hash } from "@node-rs/argon2";
import {
  blindIndex,
  createPrismaClient,
  encrypt,
  parseEncryptionKey,
  type ChannelType,
  type Prisma,
} from "../src/index.js";

const rootEnv = new URL("../../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} não definida (copie .env.example para .env)`);
  return value;
}

const prisma = createPrismaClient(requireEnv("DATABASE_ADMIN_URL"));
const key = parseEncryptionKey(requireEnv("ENCRYPTION_KEY"));

const DEMO_PASSWORD = "comanda123";
const TENANTS = [
  { slug: "cantina-da-nonna", name: "Cantina da Nonna" },
  { slug: "sushi-kaze", name: "Sushi Kaze" },
  { slug: "bistro-bellagio", name: "Bistrô Bellagio" },
] as const;
type Slug = (typeof TENANTS)[number]["slug"];

const USERS: { email: string; name: string; roles: Partial<Record<Slug, "ADMIN" | "AGENT">> }[] = [
  {
    email: "ana.silva@cantinadanonna.com.br",
    name: "Ana Silva",
    roles: { "cantina-da-nonna": "AGENT", "sushi-kaze": "ADMIN", "bistro-bellagio": "AGENT" },
  },
  { email: "diego@cantinadanonna.com.br", name: "Diego Rocha", roles: { "cantina-da-nonna": "ADMIN" } },
];

const now = Date.now();
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000);
const daysAgo = (days: number) => minutesAgo(days * 24 * 60);

async function createChannel(tenantId: string, slug: Slug, type: ChannelType, name: string) {
  return prisma.channel.create({
    data: {
      tenantId,
      type,
      name,
      externalId: `dev-${slug}-${type.toLowerCase()}`, // usado pelo simulador de webhooks
      credentials: encrypt(JSON.stringify({ accessToken: "dev" }), key),
      status: "CONNECTED",
    },
  });
}

type MessageSeed = Omit<Prisma.MessageUncheckedCreateInput, "tenantId" | "conversationId" | "channelId">;

async function createConversation(
  base: { tenantId: string; contactId: string; channelId: string },
  data: Omit<Prisma.ConversationUncheckedCreateInput, "tenantId" | "contactId" | "channelId">,
  messages: MessageSeed[],
) {
  const conversation = await prisma.conversation.create({ data: { ...base, ...data } });
  for (const message of messages) {
    await prisma.message.create({
      data: { ...message, tenantId: base.tenantId, conversationId: conversation.id, channelId: base.channelId },
    });
  }
  return conversation;
}

async function main() {
  await prisma.tenant.deleteMany({ where: { slug: { in: TENANTS.map((t) => t.slug) } } });
  await prisma.user.deleteMany({ where: { email: { in: USERS.map((u) => u.email) } } });

  const tenants = {} as Record<Slug, { id: string }>;
  for (const tenant of TENANTS) tenants[tenant.slug] = await prisma.tenant.create({ data: tenant });

  const passwordHash = await hash(DEMO_PASSWORD);
  const users = {} as Record<string, { id: string }>;
  for (const user of USERS) {
    users[user.email] = await prisma.user.create({
      data: {
        name: user.name,
        email: user.email,
        passwordHash,
        memberships: {
          create: Object.entries(user.roles).map(([slug, role]) => ({ tenantId: tenants[slug as Slug].id, role })),
        },
      },
      select: { id: true },
    });
  }
  const ana = users["ana.silva@cantinadanonna.com.br"]!.id;
  const diego = users["diego@cantinadanonna.com.br"]!.id;

  // ---------- Cantina da Nonna ----------
  const cantina = tenants["cantina-da-nonna"].id;
  const whatsapp = await createChannel(cantina, "cantina-da-nonna", "WHATSAPP", "WhatsApp");
  const instagram = await createChannel(cantina, "cantina-da-nonna", "INSTAGRAM", "Instagram");
  const ifood = await createChannel(cantina, "cantina-da-nonna", "IFOOD", "iFood");

  await prisma.quickReply.createMany({
    data: [
      {
        tenantId: cantina,
        shortcut: "atraso",
        content: "Peço desculpas pela demora! Já estou verificando com nossa equipe de entrega.",
      },
      { tenantId: cantina, shortcut: "horario", content: "Funcionamos de terça a domingo, das 11h às 23h." },
      { tenantId: cantina, shortcut: "glutem", content: "Temos lasanha sem glúten e risoto de cogumelos." },
    ],
  });

  // Maria: conversa no Instagram com coleta de telefone, pedido do iFood e nota interna.
  const maria = await prisma.contact.create({
    data: {
      tenantId: cantina,
      name: "Maria Oliveira",
      phone: "+5511976543210",
      phoneSource: "informed_by_customer",
      phoneStatus: "ok",
      cpfEncrypted: encrypt("12345678909", key),
      cpfHash: blindIndex("12345678909", key),
      tags: ["VIP", "recorrente", "sem glúten"],
      firstSeenAt: daysAgo(270),
      lastSeenAt: minutesAgo(14),
      identities: {
        create: [
          { tenantId: cantina, channelType: "INSTAGRAM", externalId: "dev-igsid-maria", profile: { username: "maria.oliveira" } },
          { tenantId: cantina, channelType: "IFOOD", externalId: "dev-ifood-customer-maria" },
        ],
      },
      addresses: {
        create: {
          tenantId: cantina,
          label: "Entrega",
          street: "Rua das Acácias",
          number: "847",
          complement: "ap. 42",
          district: "Vila Madalena",
          city: "São Paulo",
          state: "SP",
          zipCode: "05440-001",
        },
      },
    },
  });
  const mariaChat = await createConversation(
    { tenantId: cantina, contactId: maria.id, channelId: instagram.id },
    { status: "OPEN", assignedUserId: ana, unreadCount: 2, createdAt: minutesAgo(50), lastMessageAt: minutesAgo(14), windowExpiresAt: new Date(now + 23 * 3_600_000) },
    [],
  );
  const order = await prisma.order.create({
    data: {
      tenantId: cantina,
      contactId: maria.id,
      channelId: ifood.id,
      conversationId: mariaChat.id,
      externalOrderId: "dev-ifood-order-485329",
      displayCode: "485329",
      status: "DISPATCHED",
      subtotal: "62.40",
      deliveryFee: "5.00",
      total: "67.40",
      placedAt: minutesAgo(52),
      dispatchedAt: minutesAgo(14),
      raw: {},
      items: {
        create: [
          { tenantId: cantina, name: "Lasanha Bolonhesa G", quantity: 1, unitPrice: "54.90" },
          { tenantId: cantina, name: "Refrigerante Lata 350ml", quantity: 1, unitPrice: "7.50" },
        ],
      },
    },
  });
  for (const [days, total, code] of [[3, "94.20", "462110"], [12, "45.80", "441089"]] as const) {
    await prisma.order.create({
      data: {
        tenantId: cantina,
        contactId: maria.id,
        channelId: ifood.id,
        externalOrderId: `dev-ifood-order-${code}`,
        displayCode: code,
        status: "DELIVERED",
        subtotal: total,
        deliveryFee: "0.00",
        total,
        placedAt: daysAgo(days),
        deliveredAt: daysAgo(days),
        raw: {},
      },
    });
  }
  const mariaMessages: MessageSeed[] = [
    { direction: "INTERNAL", type: "SYSTEM", content: { event: "conversation_opened", text: "Conversa aberta via Instagram" }, createdAt: minutesAgo(50) },
    { direction: "OUTBOUND", type: "TEXT", status: "READ", content: { text: "Olá, Maria! 👋 Para garantirmos seu atendimento caso a conversa caia, pode nos informar seu telefone com DDD?", automation: "phone_collection" }, createdAt: minutesAgo(50) },
    { direction: "INBOUND", type: "TEXT", status: "DELIVERED", content: { text: "(11) 97654-3210" }, createdAt: minutesAgo(49) },
    { direction: "INTERNAL", type: "SYSTEM", content: { event: "phone_collected", text: "Telefone informado e cadastrado" }, createdAt: minutesAgo(49) },
    { direction: "INBOUND", type: "TEXT", status: "DELIVERED", content: { text: "Obrigada! Mas o motivo do contato é que meu pedido não chegou. São mais de 50 minutos!" }, createdAt: minutesAgo(48) },
    { direction: "INTERNAL", type: "SYSTEM", content: { event: "order", orderId: order.id }, createdAt: minutesAgo(48) },
    { direction: "INTERNAL", type: "NOTE", sentByUserId: diego, content: { text: "Verificar com motoboy. Pedido saiu às 19:45, tempo médio 25 min. Motoboy Carlos — (11) 99123-4567" }, createdAt: minutesAgo(42) },
    { direction: "OUTBOUND", type: "TEXT", status: "READ", sentByUserId: ana, content: { text: "Maria, peço desculpas pelo transtorno! Estou verificando agora com nossa equipe de entrega." }, createdAt: minutesAgo(41) },
    { direction: "OUTBOUND", type: "TEXT", status: "READ", sentByUserId: ana, content: { text: "🛵 Boa notícia! O entregador está chegando em aproximadamente 10 minutos. Mais uma vez, desculpe a espera!" }, createdAt: minutesAgo(38) },
    { direction: "INBOUND", type: "TEXT", status: "DELIVERED", content: { text: "O entregador ainda não apareceu." }, createdAt: minutesAgo(16) },
    { direction: "INBOUND", type: "TEXT", status: "DELIVERED", content: { text: "Meu pedido ainda não chegou, já fazem 50 minutos" }, createdAt: minutesAgo(14) },
  ];
  for (const message of mariaMessages) {
    await prisma.message.create({
      data: { ...message, tenantId: cantina, conversationId: mariaChat.id, channelId: instagram.id },
    });
  }

  // João: WhatsApp, aguardando resposta.
  const joao = await prisma.contact.create({
    data: {
      tenantId: cantina,
      name: "João Silva",
      phone: "+5511987654321",
      phoneSource: "channel",
      phoneStatus: "ok",
      lastSeenAt: minutesAgo(2),
      identities: { create: { tenantId: cantina, channelType: "WHATSAPP", externalId: "5511987654321" } },
    },
  });
  await createConversation(
    { tenantId: cantina, contactId: joao.id, channelId: whatsapp.id },
    { status: "PENDING", unreadCount: 1, createdAt: minutesAgo(3), lastMessageAt: minutesAgo(2), windowExpiresAt: new Date(now + 24 * 3_600_000 - 2 * 60_000) },
    [{ direction: "INBOUND", type: "TEXT", status: "DELIVERED", content: { text: "Vocês têm opção sem glúten?" }, createdAt: minutesAgo(2) }],
  );

  // Carlos: pedido novo do iFood (o iFood não tem chat por integração: a conversa só mostra os pedidos).
  const carlos = await prisma.contact.create({
    data: {
      tenantId: cantina,
      name: "Carlos Mendes",
      phoneStatus: "pending",
      lastSeenAt: minutesAgo(5),
      identities: { create: { tenantId: cantina, channelType: "IFOOD", externalId: "dev-ifood-customer-carlos" } },
    },
  });
  const carlosChat = await createConversation(
    { tenantId: cantina, contactId: carlos.id, channelId: ifood.id },
    { status: "OPEN", unreadCount: 1, createdAt: minutesAgo(5), lastMessageAt: minutesAgo(5) },
    [],
  );
  const carlosOrder = await prisma.order.create({
    data: {
      tenantId: cantina,
      contactId: carlos.id,
      channelId: ifood.id,
      conversationId: carlosChat.id,
      externalOrderId: "dev-ifood-order-485402",
      displayCode: "485402",
      status: "CONFIRMED",
      subtotal: "89.80",
      deliveryFee: "0.00",
      total: "89.80",
      placedAt: minutesAgo(5),
      raw: {},
      items: { create: { tenantId: cantina, name: "Pizza Margherita G", quantity: 2, unitPrice: "44.90" } },
    },
  });
  for (const message of [
    { direction: "INTERNAL", type: "SYSTEM", content: { event: "conversation_opened", text: "Conversa aberta via iFood" }, createdAt: minutesAgo(5) },
    { direction: "INTERNAL", type: "SYSTEM", content: { event: "order", orderId: carlosOrder.id }, createdAt: minutesAgo(5) },
  ] satisfies MessageSeed[]) {
    await prisma.message.create({ data: { ...message, tenantId: cantina, conversationId: carlosChat.id, channelId: ifood.id } });
  }

  // Fernanda: Instagram, não informou o telefone depois do pedido e do lembrete.
  const fernanda = await prisma.contact.create({
    data: {
      tenantId: cantina,
      name: "Fernanda Lima",
      phoneStatus: "pending",
      lastSeenAt: minutesAgo(8),
      identities: { create: { tenantId: cantina, channelType: "INSTAGRAM", externalId: "dev-igsid-fernanda", profile: { username: "fe.lima" } } },
    },
  });
  await createConversation(
    { tenantId: cantina, contactId: fernanda.id, channelId: instagram.id },
    { status: "OPEN", unreadCount: 1, createdAt: minutesAgo(30), lastMessageAt: minutesAgo(8), windowExpiresAt: new Date(now + 24 * 3_600_000 - 8 * 60_000), automationState: { phoneCollection: "phone_skipped" } },
    [
      { direction: "INTERNAL", type: "SYSTEM", content: { event: "conversation_opened", text: "Conversa aberta via Instagram" }, createdAt: minutesAgo(30) },
      { direction: "INBOUND", type: "TEXT", status: "DELIVERED", content: { text: "Oi, boa noite" }, createdAt: minutesAgo(30) },
      { direction: "OUTBOUND", type: "TEXT", status: "READ", content: { text: "Olá, Fernanda! 👋 Para garantirmos seu atendimento caso a conversa caia, pode nos informar seu telefone com DDD?", automation: "phone_collection" }, createdAt: minutesAgo(30) },
      { direction: "OUTBOUND", type: "TEXT", status: "DELIVERED", content: { text: "Só lembrando: pode nos passar seu telefone com DDD? 😊", automation: "phone_reminder" }, createdAt: minutesAgo(20) },
      { direction: "INTERNAL", type: "SYSTEM", content: { event: "phone_pending", text: "Telefone não informado" }, createdAt: minutesAgo(10) },
      { direction: "INBOUND", type: "TEXT", status: "DELIVERED", content: { text: "A bebida veio errada no meu pedido" }, createdAt: minutesAgo(8) },
    ],
  );

  // Ana Paula: Instagram, já resolvida.
  const anaPaula = await prisma.contact.create({
    data: {
      tenantId: cantina,
      name: "Ana Paula Costa",
      phone: "+5511912345678",
      phoneSource: "informed_by_customer",
      phoneStatus: "ok",
      lastSeenAt: minutesAgo(60),
      identities: { create: { tenantId: cantina, channelType: "INSTAGRAM", externalId: "dev-igsid-anapaula", profile: { username: "anapaula.costa" } } },
    },
  });
  await createConversation(
    { tenantId: cantina, contactId: anaPaula.id, channelId: instagram.id },
    { status: "RESOLVED", assignedUserId: ana, createdAt: minutesAgo(90), lastMessageAt: minutesAgo(60), windowExpiresAt: new Date(now + 23 * 3_600_000) },
    [
      { direction: "INBOUND", type: "TEXT", status: "DELIVERED", content: { text: "Adorei a lasanha! Quando abrem amanhã?" }, createdAt: minutesAgo(62) },
      { direction: "OUTBOUND", type: "TEXT", status: "READ", sentByUserId: ana, content: { text: "Que bom que gostou! Amanhã abrimos às 11h. 😊" }, createdAt: minutesAgo(60) },
    ],
  );

  // ---------- Sushi Kaze: uma conversa aberta (aparece no painel master) ----------
  const sushi = tenants["sushi-kaze"].id;
  const sushiWhatsapp = await createChannel(sushi, "sushi-kaze", "WHATSAPP", "WhatsApp");
  const kenji = await prisma.contact.create({
    data: {
      tenantId: sushi,
      name: "Kenji Tanaka",
      phone: "+5511955554444",
      phoneSource: "channel",
      phoneStatus: "ok",
      lastSeenAt: minutesAgo(6),
      identities: { create: { tenantId: sushi, channelType: "WHATSAPP", externalId: "5511955554444" } },
    },
  });
  await createConversation(
    { tenantId: sushi, contactId: kenji.id, channelId: sushiWhatsapp.id },
    { status: "OPEN", unreadCount: 1, createdAt: minutesAgo(6), lastMessageAt: minutesAgo(6), windowExpiresAt: new Date(now + 24 * 3_600_000 - 6 * 60_000) },
    [{ direction: "INBOUND", type: "TEXT", status: "DELIVERED", content: { text: "Vocês entregam no Brooklin?" }, createdAt: minutesAgo(6) }],
  );

  // ---------- Bistrô Bellagio: canal conectado, sem conversas ----------
  await createChannel(tenants["bistro-bellagio"].id, "bistro-bellagio", "WHATSAPP", "WhatsApp");

  console.log(`Seed concluído. Login: ${USERS[0]!.email} / ${DEMO_PASSWORD}`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
