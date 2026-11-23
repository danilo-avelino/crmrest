import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptionProcessor } from "../src/inbound/audio-media.service.js";
import { menuVocabulary, OpenRouterTranscriptionProvider, type TranscriptionProvider } from "../src/inbound/transcription.js";
import { agentMessages } from "../src/menu-agent/order-agent.service.js";
import { QUEUES } from "../src/queues/queues.module.js";
import { StorageService } from "../src/storage/storage.service.js";
import { admin, createAuthFixture, createTestApp } from "./helpers.js";

class FakeProvider implements TranscriptionProvider {
  configured = true;
  next: string | Error = "quero uma calabresa grande";
  calls: { mimeType: string; vocabulary: string }[] = [];
  async transcribe(input: { bytes: Uint8Array; mimeType: string; vocabulary: string }) {
    this.calls.push({ mimeType: input.mimeType, vocabulary: input.vocabulary });
    if (this.next instanceof Error) throw this.next;
    return { text: this.next, seconds: 4 };
  }
}

// F5-02 e F5-03: o áudio guardado vira texto com o vocabulário do cardápio, e a IA responde a ele como texto.
describe("Transcrição dos áudios do cardápio (F5-02, F5-03)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let processor: TranscriptionProcessor;
  let provider: FakeProvider;
  let aiAdd: ReturnType<typeof vi.spyOn>;
  let conversationId = "";
  let channelId = "";
  let contactId = "";

  // Cada áudio 1 ms depois do anterior: no mesmo milissegundo, o serviço não sabe qual é o último e não responde.
  let last = 0;
  const audio = async () =>
    (
      await admin.message.create({
        data: {
          tenantId: fx.b.id,
          conversationId,
          channelId,
          direction: "INBOUND",
          type: "AUDIO",
          createdAt: new Date((last = Math.max(Date.now(), last + 1))),
          content: { media: { mimeType: "audio/ogg; codecs=opus", storageKey: `tenants/${fx.b.id}/audio/${randomUUID()}.ogg`, seconds: 4 } },
        },
      })
    ).id;
  const run = (messageId: string, attemptsMade = 2) =>
    processor.process({ name: "transcribe", data: { tenantId: fx.b.id, messageId }, attemptsMade, opts: { attempts: 3 } } as unknown as Job<{ tenantId: string; messageId: string }>);
  const transcriptionOf = async (id: string) => ((await admin.message.findUniqueOrThrow({ where: { id } })).content as { media: { transcription?: string } }).media.transcription;

  beforeAll(async () => {
    app = await createTestApp();
    processor = app.get(TranscriptionProcessor, { each: true })[0]!;
    provider = new FakeProvider();
    processor.provider = provider;
    for (const storage of app.get(StorageService, { each: true })) vi.spyOn(storage, "get").mockResolvedValue(new Uint8Array([1, 2, 3]));
    // Só registra: o job "reply" de verdade faria a IA responder na conversa, e a próxima mensagem deixaria de ser o áudio.
    aiAdd = vi.spyOn(app.get<Queue>(getQueueToken(QUEUES.ai)), "add").mockResolvedValue(undefined as never);
    fx = await createAuthFixture();
    await admin.tenantModule.create({ data: { tenantId: fx.b.id, module: "MENU" } });
    const menu = await admin.menu.create({ data: { tenantId: fx.b.id, name: "Cardápio" } });
    const category = await admin.menuCategory.create({ data: { tenantId: fx.b.id, menuId: menu.id, name: "Pizzas" } });
    await admin.menuItem.create({ data: { tenantId: fx.b.id, categoryId: category.id, name: "Calabresa", priceCents: 5000 } });
    channelId = (await admin.channel.create({ data: { tenantId: fx.b.id, type: "WHATSAPP", name: "WhatsApp", externalId: `wa-${randomUUID()}`, credentials: new Uint8Array(), status: "CONNECTED" } })).id;
    contactId = (await admin.contact.create({ data: { tenantId: fx.b.id, name: "Bia", phone: "+5511933332222" } })).id;
    conversationId = (await admin.conversation.create({ data: { tenantId: fx.b.id, contactId, channelId, status: "OPEN", automationState: { ai: "on" } } })).id;
  });

  beforeEach(() => {
    aiAdd.mockClear();
    provider.next = "quero uma calabresa grande";
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  it("transcreve com o vocabulário do cardápio, grava o texto e chama a IA para responder", async () => {
    const id = await audio();
    await run(id);
    expect(await transcriptionOf(id)).toBe("quero uma calabresa grande");
    expect(provider.calls.at(-1)).toMatchObject({ mimeType: "audio/ogg; codecs=opus", vocabulary: expect.stringContaining("Calabresa") });
    expect(aiAdd).toHaveBeenCalledWith("reply", { tenantId: fx.b.id, conversationId });
    // 4 s de áudio a 3 micro-US$ por segundo, em Gastos com IA.
    expect(await admin.aiUsage.findFirst({ where: { tenantId: fx.b.id, provider: "TRANSCRIPTION" }, orderBy: { createdAt: "desc" } })).toMatchObject({ inputTokens: 4, costMicroUsd: 12 });
  });

  it("não entendeu (texto vazio ou falha na última tentativa): marca failed e pede para repetir no tom do restaurante", async () => {
    provider.next = "";
    const id = await audio();
    await run(id);
    expect(await transcriptionOf(id)).toBe("failed");
    const asked = await admin.message.findFirst({ where: { conversationId, content: { path: ["automation"], equals: "menu_audio_failed" } } });
    expect(asked).not.toBeNull();
    expect(aiAdd).not.toHaveBeenCalled();

    provider.next = new Error("Groq 500");
    const other = await audio();
    await expect(run(other, 0)).rejects.toThrow("Groq 500"); // tenta de novo
    await run(other, 2);
    expect(await transcriptionOf(other)).toBe("failed");
  });

  it("sem a chave do provedor fica pending_provider", async () => {
    provider.configured = false;
    const id = await audio();
    await run(id);
    expect(await transcriptionOf(id)).toBe("pending_provider");
    provider.configured = true;
  });

  it("OpenRouter: áudio em base64, Whisper em português e o vocabulário como prompt do Groq; sem chave, desligado", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ text: " uma calabresa ", usage: { seconds: 3 } });
    });
    try {
      const env = { OPENROUTER_API_KEY: "sk-or-teste", OPENROUTER_API_URL: "https://openrouter.ai/api/v1", TRANSCRIPTION_MODEL: "openai/whisper-large-v3-turbo" };
      expect(new OpenRouterTranscriptionProvider({ ...env, OPENROUTER_API_KEY: undefined }).configured).toBe(false);
      const out = await new OpenRouterTranscriptionProvider(env).transcribe({ bytes: new Uint8Array([1, 2]), mimeType: "audio/ogg; codecs=opus", vocabulary: "Cardápio: Calabresa." });
      expect(out).toEqual({ text: "uma calabresa", seconds: 3 });
      expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
        model: "openai/whisper-large-v3-turbo",
        input_audio: { data: "AQI=", format: "ogg" },
        language: "pt",
        provider: { options: { groq: { prompt: "Cardápio: Calabresa." } } },
      });
      expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-teste");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("o agente lê o áudio transcrito como texto do cliente", () => {
    const messages = agentMessages([
      { direction: "INBOUND", type: "AUDIO", content: { media: { mimeType: "audio/ogg", transcription: "quero uma calabresa" } }, sentByUserId: null },
      { direction: "INBOUND", type: "AUDIO", content: { media: { mimeType: "audio/ogg", transcription: "failed" } }, sentByUserId: null },
    ]);
    expect(JSON.stringify(messages)).toContain("[áudio transcrito] quero uma calabresa");
    expect(JSON.stringify(messages)).toContain("[áudio]");
    expect(menuVocabulary(["Pizzas", "Calabresa", "Calabresa"])).toBe("Pedido de delivery em português do Brasil. Cardápio: Pizzas, Calabresa.");
  });
});
