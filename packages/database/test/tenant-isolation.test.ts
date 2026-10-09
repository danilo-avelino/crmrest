import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient, PrismaClient, type TenantTx, withTenants } from "../src/index.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} não definida (copie .env.example para .env)`);
  return value;
}

const admin = createPrismaClient(requireEnv("DATABASE_ADMIN_URL")); // dono das tabelas: ignora a RLS
const app = createPrismaClient(requireEnv("DATABASE_URL")); // role da aplicação: sujeita à RLS

// Tabelas da plataforma: RLS com regras próprias (login e escolha de restaurante), sem tenant_isolation.
const PLATFORM_TABLES = ["tenants", "users", "tenant_members", "sessions"];
const ISOLATION_POLICY =
  "(tenant_id = ANY (app.current_tenant_ids())) WITH CHECK (tenant_id = ANY (app.current_tenant_ids()))";

type Row = { id: string; tenantId: string | null };

// Uma entrada por tabela de negócio. Uma tabela nova sem entrada aqui (ou sem RLS) quebra o teste do catálogo.
const tenantTables: Record<string, (db: TenantTx) => Promise<Row[]>> = {
  channels: (db) => db.channel.findMany({ select: { id: true, tenantId: true } }),
  contacts: (db) => db.contact.findMany({ select: { id: true, tenantId: true } }),
  contact_identities: (db) => db.contactIdentity.findMany({ select: { id: true, tenantId: true } }),
  contact_addresses: (db) => db.contactAddress.findMany({ select: { id: true, tenantId: true } }),
  contact_duplicate_dismissals: (db) => db.contactDuplicateDismissal.findMany({ select: { id: true, tenantId: true } }),
  consents: (db) => db.consent.findMany({ select: { id: true, tenantId: true } }),
  conversations: (db) => db.conversation.findMany({ select: { id: true, tenantId: true } }),
  messages: (db) => db.message.findMany({ select: { id: true, tenantId: true } }),
  orders: (db) => db.order.findMany({ select: { id: true, tenantId: true } }),
  order_items: (db) => db.orderItem.findMany({ select: { id: true, tenantId: true } }),
  order_events: (db) => db.orderEvent.findMany({ select: { id: true, tenantId: true } }),
  ratings: (db) => db.rating.findMany({ select: { id: true, tenantId: true } }),
  quick_replies: (db) => db.quickReply.findMany({ select: { id: true, tenantId: true } }),
  audit_logs: (db) => db.auditLog.findMany({ select: { id: true, tenantId: true } }),
};

type Seeded = { tenantId: string; userId: string; email: string; contactId: string };

// Cria um tenant com uma linha em cada tabela de negócio (via admin, sem RLS).
async function seedTenant(label: string): Promise<Seeded> {
  const suffix = randomUUID();
  const { id: tenantId } = await admin.tenant.create({
    data: { name: `Teste ${label}`, slug: `teste-${label}-${suffix}` },
  });
  const email = `${suffix}@teste.local`;
  const user = await admin.user.create({
    data: {
      name: `Atendente ${label}`,
      email,
      passwordHash: `hash-${label}`,
      memberships: { create: { tenantId, role: "AGENT" } },
      sessions: { create: { tokenHash: "-", expiresAt: new Date(Date.now() + 60_000) } },
    },
  });
  const channel = await admin.channel.create({
    data: {
      tenantId,
      type: "WHATSAPP",
      name: "WhatsApp",
      externalId: `phone-${suffix}`,
      credentials: new Uint8Array(),
      status: "CONNECTED",
    },
  });
  const contact = await admin.contact.create({
    data: {
      tenantId,
      name: `Cliente ${label}`,
      phone: "+5511999990000",
      identities: { create: { tenantId, channelType: "WHATSAPP", externalId: `wa-${suffix}` } },
      addresses: { create: { tenantId, street: "Rua das Acácias", city: "São Paulo", state: "SP" } },
      consents: { create: { tenantId, purpose: "marketing_whatsapp", granted: true, source: "whatsapp" } },
    },
  });
  const homonym = await admin.contact.create({ data: { tenantId, name: `Cliente ${label}` } });
  const [first, second] = [contact.id, homonym.id].sort();
  await admin.contactDuplicateDismissal.create({ data: { tenantId, contactAId: first!, contactBId: second! } });
  const conversation = await admin.conversation.create({
    data: { tenantId, contactId: contact.id, channelId: channel.id, status: "OPEN", assignedUserId: user.id },
  });
  await admin.message.create({
    data: {
      tenantId,
      conversationId: conversation.id,
      channelId: channel.id,
      direction: "INBOUND",
      type: "TEXT",
      content: { text: "Meu pedido ainda não chegou" },
      status: "DELIVERED",
    },
  });
  const order = await admin.order.create({
    data: {
      tenantId,
      contactId: contact.id,
      channelId: channel.id,
      conversationId: conversation.id,
      externalOrderId: `order-${suffix}`,
      status: "DISPATCHED",
      subtotal: "62.40",
      deliveryFee: "5.00",
      total: "67.40",
      placedAt: new Date(),
      raw: {},
      items: { create: { tenantId, name: "Lasanha Bolonhesa G", quantity: 1, unitPrice: "54.90" } },
    },
  });
  await admin.rating.create({ data: { tenantId, conversationId: conversation.id, orderId: order.id, score: 5 } });
  await admin.orderEvent.create({
    data: { tenantId, orderId: order.id, externalEventId: `evento-${suffix}`, code: "CONFIRMED", occurredAt: new Date() },
  });
  await admin.quickReply.create({ data: { tenantId, shortcut: "atraso", content: "Já estamos verificando." } });
  await admin.auditLog.create({
    data: { tenantId, userId: user.id, action: "contact.cpf_viewed", entity: "contact", entityId: contact.id },
  });
  return { tenantId, userId: user.id, email, contactId: contact.id };
}

function tenantsOf(rows: Row[]): Set<string | null> {
  return new Set(rows.map((row) => row.tenantId));
}

let a: Seeded;
let b: Seeded;
let c: Seeded;

beforeAll(async () => {
  [a, b, c] = await Promise.all([seedTenant("a"), seedTenant("b"), seedTenant("c")]);
});

afterAll(async () => {
  const seeds = [a, b, c].filter(Boolean);
  await admin.tenant.deleteMany({ where: { id: { in: seeds.map((s) => s.tenantId) } } });
  await admin.user.deleteMany({ where: { id: { in: seeds.map((s) => s.userId) } } });
  await Promise.all([admin.$disconnect(), app.$disconnect()]);
});

describe("isolamento entre tenants (RLS)", () => {
  it("a aplicação conecta com uma role sujeita à RLS", async () => {
    const [role] = await app.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean; ownsTables: boolean }[]>`
      SELECT rolsuper, rolbypassrls,
             EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS "ownsTables"
      FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, ownsTables: false });
  });

  it("toda tabela tem RLS e toda tabela de negócio tem só a política padrão", async () => {
    const tables = await admin.$queryRaw<
      { table: string; rls: boolean; hasTenantId: boolean; policies: number; isolation: string | null }[]
    >`
      SELECT c.relname::text AS "table",
             c.relrowsecurity AS "rls",
             EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS "hasTenantId",
             (SELECT count(*)::int FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS "policies",
             (SELECT p.qual || ' WITH CHECK ' || p.with_check FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS "isolation"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'`;

    expect(tables.filter((t) => !t.rls).map((t) => t.table)).toEqual([]);

    for (const t of tables.filter((t) => PLATFORM_TABLES.includes(t.table))) {
      expect(t.isolation, t.table).toBeNull();
    }

    const business = tables.filter((t) => !PLATFORM_TABLES.includes(t.table));
    expect(business.map((t) => t.table).sort()).toEqual(Object.keys(tenantTables).sort());
    for (const t of business) {
      expect(t.hasTenantId, t.table).toBe(true);
      expect(t.policies, t.table).toBe(1);
      expect(t.isolation, t.table).toBe(ISOLATION_POLICY);
    }
  });

  it("sem contexto de tenant nada fica visível", async () => {
    for (const [table, findAll] of Object.entries(tenantTables)) {
      expect(await findAll(app), table).toEqual([]);
    }
  });

  it("modo restaurante: vê só as linhas do próprio tenant", async () => {
    await withTenants(app, { tenantIds: [a.tenantId] }, async (tx) => {
      for (const [table, findAll] of Object.entries(tenantTables)) {
        expect(tenantsOf(await findAll(tx)), table).toEqual(new Set([a.tenantId]));
      }
    });
  });

  it("modo master: vê os tenants da lista e nunca os de fora", async () => {
    await withTenants(app, { tenantIds: [a.tenantId, b.tenantId] }, async (tx) => {
      for (const [table, findAll] of Object.entries(tenantTables)) {
        expect(tenantsOf(await findAll(tx)), table).toEqual(new Set([a.tenantId, b.tenantId]));
      }
    });
  });

  it("não grava em tenant fora do contexto", async () => {
    await expect(
      withTenants(app, { tenantIds: [a.tenantId] }, (tx) => tx.contact.create({ data: { tenantId: c.tenantId, name: "Invasor" } })),
    ).rejects.toThrow(/row-level security/);

    await expect(
      withTenants(app, { tenantIds: [a.tenantId] }, (tx) =>
        tx.contact.update({ where: { id: a.contactId }, data: { tenantId: c.tenantId } }),
      ),
    ).rejects.toThrow(/row-level security/);

    const changed = await withTenants(app, { tenantIds: [a.tenantId] }, async (tx) => ({
      updated: await tx.contact.updateMany({ where: { id: c.contactId }, data: { name: "Invasor" } }),
      deleted: await tx.contact.deleteMany({ where: { id: c.contactId } }),
    }));
    expect(changed).toEqual({ updated: { count: 0 }, deleted: { count: 0 } });
  });

  it("plataforma: no contexto de um tenant, só o tenant, os vínculos e os colegas dele", async () => {
    await withTenants(app, { tenantIds: [a.tenantId] }, async (tx) => {
      expect((await tx.tenant.findMany({ select: { id: true } })).map((t) => t.id)).toEqual([a.tenantId]);
      expect(new Set((await tx.tenantMember.findMany({ select: { tenantId: true } })).map((m) => m.tenantId))).toEqual(
        new Set([a.tenantId]),
      );
      expect((await tx.user.findMany({ select: { id: true } })).map((u) => u.id)).toEqual([a.userId]);
      expect(await tx.session.findMany()).toEqual([]);
    });
  });

  it("plataforma: o usuário logado vê os próprios vínculos, restaurantes e sessões, nunca os de outros", async () => {
    await withTenants(app, { tenantIds: [], userId: a.userId }, async (tx) => {
      expect((await tx.tenantMember.findMany({ select: { tenantId: true } })).map((m) => m.tenantId)).toEqual([
        a.tenantId,
      ]);
      expect((await tx.tenant.findMany({ select: { id: true } })).map((t) => t.id)).toEqual([a.tenantId]);
      expect((await tx.user.findMany({ select: { id: true } })).map((u) => u.id)).toEqual([a.userId]);
      expect(new Set((await tx.session.findMany()).map((s) => s.userId))).toEqual(new Set([a.userId]));
      // Não cria sessão em nome de outro usuário.
      await expect(
        tx.session.create({ data: { userId: c.userId, tokenHash: "-", expiresAt: new Date() } }),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it("o hash da senha só sai pela função de login", async () => {
    await expect(
      withTenants(app, { tenantIds: [a.tenantId], userId: a.userId }, (tx) => tx.$queryRaw`SELECT password_hash FROM users`),
    ).rejects.toThrow(/permission denied/);

    const [found] = await app.$queryRaw<{ id: string; password_hash: string }[]>`
      SELECT id, password_hash FROM app.find_login_user(${a.email.toUpperCase()})`;
    expect(found).toEqual({ id: a.userId, password_hash: "hash-a" });
  });

  it("o contexto não sobra para a próxima transação na mesma conexão", async () => {
    const singleConnection = new PrismaClient({
      adapter: new PrismaPg({ connectionString: requireEnv("DATABASE_URL"), max: 1 }),
    });
    try {
      expect(await withTenants(singleConnection, { tenantIds: [a.tenantId] }, (tx) => tx.contact.count())).toBeGreaterThan(0);
      expect(await singleConnection.contact.count()).toBe(0);
    } finally {
      await singleConnection.$disconnect();
    }
  });

  it("rejeita id de tenant malformado em vez de interpretá-lo", async () => {
    await expect(
      withTenants(app, { tenantIds: [`${a.tenantId},${c.tenantId}`] }, (tx) => tx.contact.count()),
    ).rejects.toThrow(/uuid/);
  });
});
