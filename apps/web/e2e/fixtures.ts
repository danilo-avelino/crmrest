import { createCipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import pg from "pg";

export const PASSWORD = "senha-e2e-123";

/**
 * Dois restaurantes e uma usuária com acesso aos dois; tudo é apagado no cleanup.
 * SQL direto com o dono das tabelas: o Playwright não carrega os pacotes ESM do workspace.
 */
export async function createLoginFixture() {
  const db = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await db.connect();
  const suffix = randomUUID().slice(0, 8);
  const tenants = ["Trattoria", "Pizzaria"].map((name) => ({
    id: randomUUID(),
    name: `${name} E2E ${suffix}`,
    slug: `e2e-${name.toLowerCase()}-${suffix}`,
  }));
  const user = { id: randomUUID(), email: `e2e-${suffix}@teste.local` };

  for (const tenant of tenants) {
    await db.query("INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)", [tenant.id, tenant.name, tenant.slug]);
  }
  await db.query("INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)", [
    user.id,
    "Bruna Teste",
    user.email,
    await hash(PASSWORD),
  ]);
  for (const [index, tenant] of tenants.entries()) {
    await db.query(`INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, $3::"TenantRole")`, [
      tenant.id,
      user.id,
      index === 0 ? "AGENT" : "ADMIN",
    ]);
  }

  return {
    db,
    suffix,
    tenants,
    user,
    async cleanup() {
      await db.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [tenants.map((t) => t.id)]);
      await db.query("DELETE FROM users WHERE id = $1", [user.id]);
      await db.end();
    },
  };
}

/** No primeiro restaurante: WhatsApp conectado, um cliente com uma conversa aberta e uma resposta rápida. */
export async function createInboxFixture() {
  const fx = await createLoginFixture();
  const tenantId = fx.tenants[0]!.id;
  const channel = { id: randomUUID(), externalId: `e2e-whatsapp-${fx.suffix}` };
  const contact = { id: randomUUID(), name: `Cliente E2E ${fx.suffix}`, waId: "5511955550000" };
  const conversationId = randomUUID();

  await fx.db.query(
    `INSERT INTO channels (id, tenant_id, type, name, external_id, credentials, status)
     VALUES ($1, $2, 'WHATSAPP', 'WhatsApp', $3, $4, 'CONNECTED')`,
    [channel.id, tenantId, channel.externalId, encrypt(JSON.stringify({ accessToken: "e2e" }))],
  );
  await fx.db.query(
    `INSERT INTO contacts (id, tenant_id, name, phone, phone_source, phone_status) VALUES ($1, $2, $3, $4, 'channel', 'ok')`,
    [contact.id, tenantId, contact.name, `+${contact.waId}`],
  );
  await fx.db.query(
    `INSERT INTO contact_identities (id, tenant_id, contact_id, channel_type, external_id) VALUES ($1, $2, $3, 'WHATSAPP', $4)`,
    [randomUUID(), tenantId, contact.id, contact.waId],
  );
  await fx.db.query(
    `INSERT INTO conversations (id, tenant_id, contact_id, channel_id, status, unread_count, last_message_at, window_expires_at)
     VALUES ($1, $2, $3, $4, 'OPEN', 1, now(), now() + interval '23 hours')`,
    [conversationId, tenantId, contact.id, channel.id],
  );
  await fx.db.query(
    `INSERT INTO messages (id, tenant_id, conversation_id, channel_id, external_message_id, direction, type, content, status)
     VALUES ($1, $2, $3, $4, $5, 'INBOUND', 'TEXT', $6, 'DELIVERED')`,
    [randomUUID(), tenantId, conversationId, channel.id, `wamid.E2E-${fx.suffix}`, { text: "Olá, vocês entregam hoje?" }],
  );
  await fx.db.query("INSERT INTO quick_replies (id, tenant_id, shortcut, content) VALUES ($1, $2, 'atraso', $3)", [
    randomUUID(),
    tenantId,
    "Peço desculpas pela demora! Já estou verificando.",
  ]);

  // Segundo cliente: a janela de 24h já fechou (só template).
  const closedContact = { id: randomUUID(), name: `Cliente Sem Janela ${fx.suffix}`, waId: "5511955551111" };
  await fx.db.query(`INSERT INTO contacts (id, tenant_id, name, phone, phone_source, phone_status) VALUES ($1, $2, $3, $4, 'channel', 'ok')`, [
    closedContact.id,
    tenantId,
    closedContact.name,
    `+${closedContact.waId}`,
  ]);
  await fx.db.query(
    `INSERT INTO contact_identities (id, tenant_id, contact_id, channel_type, external_id) VALUES ($1, $2, $3, 'WHATSAPP', $4)`,
    [randomUUID(), tenantId, closedContact.id, closedContact.waId],
  );
  await fx.db.query(
    `INSERT INTO conversations (id, tenant_id, contact_id, channel_id, status, last_message_at, window_expires_at)
     VALUES ($1, $2, $3, $4, 'OPEN', now() - interval '2 days', now() - interval '1 day')`,
    [randomUUID(), tenantId, closedContact.id, channel.id],
  );

  return { ...fx, channel, contact, closedContact };
}

/** Webhook do WhatsApp assinado como a Meta faria, direto na API (simula o cliente escrevendo). */
export async function sendWhatsAppWebhook(channelExternalId: string, from: string, text: string) {
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-E2E",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "5511", phone_number_id: channelExternalId },
              messages: [{ from, id: `wamid.E2E-${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  });
  const signature = createHmac("sha256", process.env.META_APP_SECRET ?? "").update(raw).digest("hex");
  const response = await fetch("http://localhost:4000/api/webhooks/meta", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": `sha256=${signature}` },
    body: raw,
  });
  if (!response.ok) throw new Error(`Webhook recusado: ${response.status}`);
}

/** Mesmo formato de @comanda/database (AES-256-GCM: iv + tag + conteúdo). */
function encrypt(plaintext: string): Buffer {
  const key = Buffer.from(process.env.ENCRYPTION_KEY ?? "", "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const content = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), content]);
}
