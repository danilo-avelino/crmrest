import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPrismaClient, encrypt, parseEncryptionKey } from "@comanda/database";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { hash } from "@node-rs/argon2";
import type { Queue } from "bullmq";
import request from "supertest";
import { expect, vi } from "vitest";
import { configureApp } from "../src/app.js";
import { AppModule } from "../src/app.module.js";
import { loadEnv } from "../src/config/env.js";
import { QUEUES } from "../src/queues/queues.module.js";

/** Dono das tabelas (ignora a RLS): só para preparar e limpar dados de teste. */
export const admin = createPrismaClient(process.env.DATABASE_ADMIN_URL ?? "");

export async function createTestApp(overrides: Record<string, string> = {}): Promise<INestApplication> {
  const env = loadEnv({ ...process.env, ...overrides });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRole(env)] }).compile();
  return configureApp(moduleRef.createNestApplication({ rawBody: true }), env).init();
}

export const PASSWORD = "senha-de-teste-123";

/** Três restaurantes (A, B, C) e um usuário com acesso a A (atendente) e B (admin), nunca a C. */
export async function createAuthFixture() {
  const suffix = randomUUID();
  const [a, b, c] = await Promise.all(
    ["a", "b", "c"].map((label) =>
      admin.tenant.create({ data: { name: `Teste ${label.toUpperCase()}`, slug: `teste-${label}-${suffix}` } }),
    ),
  );
  const user = await admin.user.create({
    data: {
      name: "Atendente Teste",
      email: `${suffix}@teste.local`,
      passwordHash: await hash(PASSWORD),
      memberships: {
        create: [
          { tenantId: a!.id, role: "AGENT" },
          { tenantId: b!.id, role: "ADMIN" },
        ],
      },
    },
    select: { id: true, email: true },
  });
  return {
    a: a!,
    b: b!,
    c: c!,
    user,
    async cleanup() {
      await admin.tenant.deleteMany({ where: { id: { in: [a!.id, b!.id, c!.id] } } });
      await admin.user.deleteMany({ where: { id: user.id } });
    },
  };
}

/** Um restaurante com WhatsApp, Instagram e iFood conectados e um atendente. */
export async function createChannelFixture() {
  const key = parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "");
  const suffix = randomUUID();
  const tenant = await admin.tenant.create({ data: { name: "Restaurante Pipeline", slug: `pipeline-${suffix}` } });
  const user = await admin.user.create({
    data: {
      name: "Atendente Pipeline",
      email: `${suffix}@teste.local`,
      passwordHash: await hash(PASSWORD),
      memberships: { create: { tenantId: tenant.id, role: "AGENT" } },
    },
    select: { id: true, email: true },
  });
  const channel = (type: "WHATSAPP" | "INSTAGRAM" | "IFOOD") =>
    admin.channel.create({
      data: {
        tenantId: tenant.id,
        type,
        name: type,
        externalId: `${type.toLowerCase()}-${suffix}`,
        credentials: encrypt(JSON.stringify({ accessToken: "token-de-teste", wabaId: "waba-teste" }), key),
        status: "CONNECTED",
      },
    });
  const [whatsapp, instagram, ifood] = await Promise.all([channel("WHATSAPP"), channel("INSTAGRAM"), channel("IFOOD")]);
  return {
    tenant,
    user,
    whatsapp,
    instagram,
    ifood,
    async cleanup() {
      await admin.tenant.deleteMany({ where: { id: tenant.id } });
      await admin.user.deleteMany({ where: { id: user.id } });
    },
  };
}

/** Access token depois de escolher um restaurante (id) ou o painel master ("master"), como o painel faz. */
export async function accessTokenFor(app: INestApplication, email: string, tenantId: string): Promise<string> {
  const agent = request.agent(app.getHttpServer());
  await agent.post("/api/auth/login").send({ email, password: PASSWORD }).expect(200);
  const context = tenantId === "master" ? { mode: "master" } : { mode: "tenant", tenantId };
  const { body } = await agent.post("/api/auth/context").send(context).expect(200);
  return body.accessToken as string;
}

/** Webhook da Meta para um número do WhatsApp (formato da Cloud API). */
export function metaPayload(phoneNumberId: string, value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-TESTE",
        changes: [
          {
            field: "messages",
            value: { messaging_product: "whatsapp", metadata: { display_phone_number: "5511", phone_number_id: phoneNumberId }, ...value },
          },
        ],
      },
    ],
  };
}

/** Webhook do Instagram para uma conta profissional (API com login do Instagram). */
export function instagramPayload(igAccountId: string, events: unknown[]) {
  return { object: "instagram", entry: [{ id: igAccountId, time: Date.now(), messaging: events }] };
}

export function instagramText(senderId: string, igAccountId: string, mid: string, text: string) {
  return { sender: { id: senderId }, recipient: { id: igAccountId }, timestamp: Date.now(), message: { mid, text } };
}

export function signMeta(raw: string, secret = process.env.META_APP_SECRET ?? ""): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

export function postMetaWebhook(app: INestApplication, payload: unknown, secret?: string) {
  const raw = JSON.stringify(payload);
  return request(app.getHttpServer())
    .post("/api/webhooks/meta")
    .set("Content-Type", "application/json")
    .set("X-Hub-Signature-256", signMeta(raw, secret))
    .send(raw);
}

/** Espera as filas esvaziarem (os workers rodam no próprio processo de teste). */
export async function drainQueues(app: INestApplication): Promise<void> {
  const queues = [QUEUES.inbound, QUEUES.outbound].map((name) => app.get<Queue>(getQueueToken(name)));
  await vi.waitFor(
    async () => {
      for (const queue of queues) {
        const counts = await queue.getJobCounts("waiting", "active", "delayed", "prioritized");
        expect(Object.values(counts).reduce((sum, n) => sum + n, 0)).toBe(0);
      }
    },
    { timeout: 15_000, interval: 100 },
  );
}

type GraphReply = { status: number; body: unknown };
type GraphRequest = { method: string; path: string; authorization?: string; body: unknown };

/** Resposta padrão: perfil do Instagram no GET; no POST, os ids de mensagem do WhatsApp e do Instagram. */
const defaultReply = (request: GraphRequest, count: number): GraphReply =>
  request.method === "GET"
    ? { status: 200, body: { name: "Fernanda Lima", username: "fe.lima" } }
    : { status: 200, body: { messages: [{ id: `wamid.MOCK${count}` }], message_id: `mid.MOCK${count}` } };

/** Graph API falsa (Meta e Instagram): registra as requisições e responde (ou com o erro configurado). */
export async function startMockGraph() {
  const requests: GraphRequest[] = [];
  let reply = (request: GraphRequest): GraphReply => defaultReply(request, requests.length);
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    // Corpo em JSON ou, na troca de código do login do Instagram, um formulário (fica como texto).
    const parsed = !raw ? null : req.headers["content-type"]?.includes("json") ? JSON.parse(raw) : raw;
    const request = { method: req.method ?? "GET", path: req.url ?? "", authorization: req.headers.authorization, body: parsed };
    requests.push(request);
    const { status, body } = reply(request);
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    reply(next: (request: GraphRequest) => GraphReply) {
      reply = next;
    },
    resetReply() {
      reply = (request) => defaultReply(request, requests.length);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
