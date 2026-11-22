import { randomInt } from "node:crypto";
import { encrypt, parseEncryptionKey } from "@dishdesk/database";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConnectorsService } from "../src/connectors/connectors.service.js";
import { QUEUES } from "../src/queues/queues.module.js";
import { accessTokenFor, admin, createAuthFixture, createTestApp, startMockGraph } from "./helpers.js";

const SUPA = "https://proj.supabase.co";
const WEBHOOK_TOKEN = "token-do-webhook-da-evolution";
const nowSeconds = () => Math.floor(Date.now() / 1000);
const randomNumber = () => `55869${String(randomInt(10_000_000, 99_999_999))}`;
const realFetch = globalThis.fetch;

describe("Áudio recebido guardado no storage (F5-01)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let evolution: Awaited<ReturnType<typeof startMockGraph>>;
  let token: string;
  const stored: { key: string; bytes: Uint8Array }[] = [];
  const puts: string[] = [];
  let audioBytes = Buffer.from("bytes-do-audio");
  const menu = { number: randomNumber(), instance: "", channelId: "" };
  const plain = { number: randomNumber(), instance: "", channelId: "" };

  beforeAll(async () => {
    evolution = await startMockGraph();
    evolution.reply((req) =>
      req.path.startsWith("/chat/getBase64FromMediaMessage/")
        ? { status: 201, body: { base64: audioBytes.toString("base64"), mimetype: "audio/ogg; codecs=opus" } }
        : { status: 200, body: {} },
    );
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      if (!url.startsWith(SUPA)) return realFetch(input, init);
      const method = init.method ?? "GET";
      const key = url.split("/object/menu-private/")[1];
      if (method === "POST" && key) {
        stored.push({ key, bytes: init.body as Uint8Array });
        puts.push(key);
        return new Response("{}", { status: 200 });
      }
      if (method === "GET" && key) return new Response(stored.find((s) => s.key === key)!.bytes as unknown as ConstructorParameters<typeof Response>[0], { status: 200 });
      return new Response("{}", { status: 200 });
    });
    app = await createTestApp({
      CHANNELS_DRY_RUN: "false",
      EVOLUTION_API_URL: evolution.url,
      EVOLUTION_API_KEY: "chave-global",
      EVOLUTION_WEBHOOK_URL: "http://api.interna/api/webhooks/evolution",
      EVOLUTION_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
      SUPABASE_URL: SUPA,
      SUPABASE_SECRET_KEY: "sk",
    });
    fx = await createAuthFixture();
    token = await accessTokenFor(app, fx.user.email, fx.b.id);
    await admin.tenantModule.create({ data: { tenantId: fx.b.id, module: "MENU" } });
    const key = parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "");
    for (const [side, tenantId] of [[menu, fx.b.id], [plain, fx.c.id]] as const) {
      side.instance = `instancia-${side.number}`;
      const accessToken = app.get(ConnectorsService).evolution.instanceToken(side.instance);
      const channel = await admin.channel.create({
        data: {
          tenantId,
          type: "WHATSAPP",
          name: "WhatsApp QR",
          externalId: side.number,
          credentials: encrypt(JSON.stringify({ accessToken, instance: side.instance }), key),
          status: "CONNECTED",
        },
      });
      side.channelId = channel.id;
    }
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await fx?.cleanup();
    await app?.close();
    await evolution?.close();
  });

  const audio = (side: typeof menu, id: string) =>
    request(app.getHttpServer())
      .post("/api/webhooks/evolution")
      .set("x-dishdesk-token", WEBHOOK_TOKEN)
      .send({
        event: "messages.upsert",
        instance: side.instance,
        sender: `${side.number}@s.whatsapp.net`,
        data: {
          key: { id, remoteJid: "5511922220001@s.whatsapp.net", fromMe: false },
          pushName: "Cliente",
          messageType: "audioMessage",
          messageTimestamp: nowSeconds(),
          message: { audioMessage: { mimetype: "audio/ogg; codecs=opus" } },
        },
      })
      .expect(200);
  const queue = () => app.get<Queue>(getQueueToken(QUEUES.transcription));
  const row = (side: typeof menu, id: string) => admin.message.findFirstOrThrow({ where: { channelId: side.channelId, externalMessageId: id } });
  const arrived = (side: typeof menu, id: string) =>
    vi.waitFor(async () => expect(await admin.message.count({ where: { channelId: side.channelId, externalMessageId: id } })).toBe(1), { timeout: 15_000, interval: 100 });
  const mediaOf = async (side: typeof menu, id: string) => ((await row(side, id)).content as { media: Record<string, unknown> }).media;

  it("sem o módulo MENU: nada é enfileirado nem guardado", async () => {
    await audio(plain, "AUD-PLAIN");
    await arrived(plain, "AUD-PLAIN");
    const message = await row(plain, "AUD-PLAIN");
    expect(await queue().getJob(`store-audio-${message.id}`)).toBeUndefined();
    expect(await queue().getJobCounts("waiting", "active", "delayed", "completed", "failed")).toMatchObject({ waiting: 0, active: 0 });
    expect(await mediaOf(plain, "AUD-PLAIN")).toEqual({ mimeType: "audio/ogg; codecs=opus", externalMediaId: "AUD-PLAIN" });
    expect(puts).toHaveLength(0);
  });

  it("com o módulo MENU: guarda o áudio e enfileira a transcrição uma vez, mesmo com o webhook repetido", async () => {
    await audio(menu, "AUD-1");
    await audio(menu, "AUD-1");
    await arrived(menu, "AUD-1");
    const message = await row(menu, "AUD-1");
    await vi.waitFor(async () => expect((await mediaOf(menu, "AUD-1")).transcription).toBe("pending_provider"), { timeout: 15_000, interval: 100 });
    const media = await mediaOf(menu, "AUD-1");
    expect(media.storageKey).toMatch(new RegExp(`^tenants/${fx.b.id}/audio/[0-9a-f-]{36}\.ogg$`));
    expect(puts).toHaveLength(1);
    expect(Buffer.from(stored[0]!.bytes).toString()).toBe("bytes-do-audio");
    expect(await admin.message.count({ where: { channelId: menu.channelId, externalMessageId: "AUD-1" } })).toBe(1);
    expect(await queue().getJob(`transcribe-${message.id}`)).toBeDefined();
    expect(await queue().getJobCounts("completed")).toMatchObject({ completed: expect.any(Number) });
  });

  it("áudio acima de 16 MB é recusado e marcado, sem guardar", async () => {
    audioBytes = Buffer.alloc(16 * 1024 * 1024 + 1, 1);
    const before = puts.length;
    await audio(menu, "AUD-BIG");
    await arrived(menu, "AUD-BIG");
    await vi.waitFor(async () => expect((await mediaOf(menu, "AUD-BIG")).storeError).toBe("too_large"), { timeout: 15_000, interval: 100 });
    expect(puts).toHaveLength(before);
    expect((await mediaOf(menu, "AUD-BIG")).storageKey).toBeUndefined();
    expect(await queue().getJob(`transcribe-${(await row(menu, "AUD-BIG")).id}`)).toBeUndefined();
  });

  it("a inbox lê o áudio guardado do storage, sem buscar na plataforma", async () => {
    const message = await row(menu, "AUD-1");
    const fetches = evolution.requests.length;
    const response = await request(app.getHttpServer())
      .get(`/api/conversations/${message.conversationId}/messages/${message.id}/media`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect((response.body as Buffer).toString()).toBe("bytes-do-audio");
    expect(evolution.requests).toHaveLength(fetches);
  });
});
