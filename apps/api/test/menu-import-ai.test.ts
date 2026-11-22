import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagesApi } from "../src/ai/llm-provider.js";
import { type Env, loadEnv } from "../src/config/env.js";
import type { DatabaseService } from "../src/core/database.service.js";
import { planImport } from "../src/menu/menu-import.js";
import { type AiExtraction, aiFileProblem, pdfPageCount, toImportRows } from "../src/menu/menu-import-ai.js";
import { MenuImportAiExtractor, MenuReadError } from "../src/menu/menu-import-ai.service.js";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

const TENANT = "019a0000-0000-7000-8000-000000000001";
const usage = { input_tokens: 3000, output_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const reply = (text: string, stop_reason = "end_turn") => ({ content: [{ type: "text", text }], stop_reason, usage });

const item = (over: Partial<AiExtraction["items"][number]> = {}): AiExtraction["items"][number] => ({
  category: "Pizzas",
  item: "Calabresa",
  description: null,
  price: 34.9,
  sizes: [],
  page: 1,
  lowConfidence: [],
  note: null,
  suggestions: [],
  ...over,
});
const EXTRACTION: AiExtraction = {
  readable: true,
  problem: null,
  items: [
    item({ description: "Linguiça e cebola" }),
    item({ item: "Portugeusa", price: 36.9, lowConfidence: ["item"], note: "Nome com letras trocadas.", suggestions: [{ field: "item", value: "Portuguesa" }] }),
    item({ item: "Quatro queijos", price: null, lowConfidence: ["price"], note: "Preço borrado na foto." }),
    item({ category: "Bebidas", item: "Suco", price: null, sizes: [{ name: "300 ml", price: 9 }, { name: "500 ml", price: 12.5 }] }),
    item({ category: "Sobremesas", item: "Fondue", description: "deal para um jantar a doi.", price: 89, suggestions: [{ field: "description", value: "Ideal para um jantar a dois." }] }),
  ],
};

describe("Importação por foto/PDF com IA (F2-10): leitura", () => {
  const usages: unknown[] = [];
  const db = {
    withTenants: (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({ aiUsage: { create: ({ data }: { data: unknown }) => usages.push(data) } }),
  } as unknown as DatabaseService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let requests: any[];
  let replies: unknown[];
  const api = { create: async (body: unknown) => (requests.push(body), replies.shift()) } as unknown as MessagesApi;
  const extractor = () => new MenuImportAiExtractor({} as Env, db, api);

  beforeEach(() => {
    requests = [];
    replies = [];
    usages.length = 0;
  });

  it("a leitura vira as mesmas linhas do CSV, com tamanhos em linhas e preço em centavos", async () => {
    replies.push(reply(JSON.stringify(EXTRACTION)));
    const rows = await extractor().extract(TENANT, new Uint8Array([1, 2, 3]), "image/png");
    expect(rows.map((row) => [row.line, row.category, row.item, row.priceCents, row.size, row.sizePriceCents])).toEqual([
      [1, "Pizzas", "Calabresa", 3490, null, null],
      [2, "Pizzas", "Portugeusa", 3690, null, null],
      [3, "Pizzas", "Quatro queijos", null, null, null],
      [4, "Bebidas", "Suco", null, "300 ml", 900],
      [5, "Bebidas", "Suco", null, "500 ml", 1250],
      [6, "Sobremesas", "Fondue", 8900, null, null],
    ]);
    expect(rows[0]).toMatchObject({ description: "Linguiça e cebola", ingredients: [], allergens: [], servesPeople: null, tags: [], synonyms: [], errors: [] });
    expect(rows[5]!.ai.suggestions).toEqual([{ field: "description", value: "Ideal para um jantar a dois." }]);

    const body = requests[0];
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.messages[0].content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } });
    expect(usages).toEqual([expect.objectContaining({ tenantId: TENANT, provider: "CLAUDE", model: "claude-sonnet-5-5", inputTokens: 3000, outputTokens: 800 })]);
  });

  it("PDF vai como document; campos de baixa confiança e sugestões ficam marcados na linha", async () => {
    replies.push(reply(JSON.stringify(EXTRACTION)));
    const rows = await extractor().extract(TENANT, new Uint8Array([1]), "application/pdf");
    expect(requests[0].messages[0].content[0]).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf" } });
    expect(rows[1]!.ai).toEqual({ page: 1, lowConfidence: ["item"], note: "Nome com letras trocadas.", suggestions: [{ field: "item", value: "Portuguesa" }] });
    expect(rows[2]!.ai.lowConfidence).toEqual(["price"]);
    // O preço que a IA não leu vira o erro da revisão (mesma regra do CSV).
    const { rows: checked, counts } = planImport(rows, new Map());
    expect(checked[2]!.errors).toEqual(["Falta o preço (ou o tamanho com o preço dele)."]);
    expect(counts).toMatchObject({ rows: 6, validRows: 5, items: 4, sizes: 2 });
  });

  it("resposta fora do formato tenta de novo uma vez; duas vezes recusa", async () => {
    replies.push(reply("não é json"), reply(JSON.stringify(EXTRACTION)));
    expect(await extractor().extract(TENANT, new Uint8Array([1]), "image/jpeg")).toHaveLength(6);
    expect(requests).toHaveLength(2);
    expect(usages).toHaveLength(2);

    requests = [];
    replies.push(reply("{}"), reply('{"items": "x"}'));
    await expect(extractor().extract(TENANT, new Uint8Array([1]), "image/jpeg")).rejects.toBeInstanceOf(MenuReadError);
    expect(requests).toHaveLength(2);
  });

  it("arquivo ilegível, recusa do modelo ou IA desligada viram erro para a tela", async () => {
    replies.push(reply(JSON.stringify({ readable: false, problem: "A foto está escura.", items: [] })));
    await expect(extractor().extract(TENANT, new Uint8Array([1]), "image/png")).rejects.toThrow(/A foto está escura\. Não conseguimos ler/);
    replies.push(reply("", "refusal"));
    await expect(extractor().extract(TENANT, new Uint8Array([1]), "image/png")).rejects.toBeInstanceOf(MenuReadError);
    await expect(new MenuImportAiExtractor({} as Env, db).extract(TENANT, new Uint8Array([1]), "image/png")).rejects.toThrow(/não está disponível/);
  });

  it("confere tipo, tamanho e páginas do arquivo", () => {
    const pdf = (pages: number) => new TextEncoder().encode(`%PDF-1.4 << /Type /Pages /Count ${pages} >> ${"<< /Type /Page >> ".repeat(pages)}`);
    expect(pdfPageCount(pdf(3))).toBe(3);
    expect(aiFileProblem("application/pdf", pdf(10))).toBeNull();
    expect(aiFileProblem("application/pdf", pdf(11))).toMatch(/mais de 10 páginas/);
    expect(aiFileProblem("image/gif", new Uint8Array([1]))).toMatch(/JPG, PNG ou WEBP/);
    expect(aiFileProblem("image/png", new Uint8Array(5 * 1024 * 1024 + 1))).toMatch(/5 MB/);
    expect(aiFileProblem("application/pdf", new Uint8Array(10 * 1024 * 1024 + 1))).toMatch(/10 MB/);
    expect(aiFileProblem("image/png", new Uint8Array(0))).toMatch(/vazio/);
    expect(toImportRows({ readable: true, problem: null, items: [item({ item: "  X ", sizes: [{ name: " ", price: 1 }] })] })[0]).toMatchObject({ item: "X", size: null, priceCents: 3490 });
  });
});

describe("Importação por foto/PDF com IA (F2-10): API", () => {
  const SUPA = "https://proj.supabase.co";
  const CLAUDE = "https://claude.teste";
  const realFetch = globalThis.fetch;
  const stored = new Map<string, Uint8Array>();
  let claudeCalls = 0;
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let other: Awaited<ReturnType<typeof createAuthFixture>>;
  let adminToken: string; // administrador em B
  let agentToken: string; // atendente em A
  let otherToken: string; // administrador no B de outro fixture
  let redis: Redis;
  const today = new Date().toISOString().slice(0, 10);
  const enable = (tenantId: string) => admin.tenantModule.upsert({ where: { tenantId_module: { tenantId, module: "MENU" } }, create: { tenantId, module: "MENU" }, update: {} });
  const upload = (tenantId: string, token: string, bytes: Uint8Array = new Uint8Array([137, 80, 78, 71]), type = "image/png") =>
    request(app.getHttpServer())
      .post(`/api/menu/${tenantId}/import/ai`)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", type)
      .set("X-File-Name", encodeURIComponent("cardápio balcão.png"))
      .send(Buffer.from(bytes));
  const status = (tenantId: string, jobId: string, token = adminToken) =>
    request(app.getHttpServer()).get(`/api/menu/${tenantId}/import/ai/${jobId}`).set("Authorization", `Bearer ${token}`);
  async function waitDone(tenantId: string, jobId: string, token = adminToken) {
    for (let i = 0; i < 100; i++) {
      const { body } = await status(tenantId, jobId, token).expect(200);
      if (body.status !== "reading") return body;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("leitura não terminou");
  }

  beforeAll(async () => {
    redis = new Redis(loadEnv(process.env).REDIS_URL);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      if (url.startsWith(CLAUDE)) {
        claudeCalls++;
        return new Response(
          JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", ...reply(JSON.stringify(EXTRACTION)) }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (!url.startsWith(SUPA)) return realFetch(input, init);
      const path = url.slice(`${SUPA}/storage/v1`.length);
      if (path.startsWith("/object/sign/")) return new Response(JSON.stringify({ signedURL: `/object/sign/menu-private/x?token=t` }), { status: 200 });
      const key = path.replace(/^\/object\/menu-private\//, "");
      if (init.method === "POST") stored.set(key, new Uint8Array(init.body as Uint8Array));
      if (init.method === "GET") return stored.has(key) ? new Response(stored.get(key) as Uint8Array<ArrayBuffer>, { status: 200 }) : new Response("", { status: 404 });
      return new Response("{}", { status: 200 });
    });
    app = await createTestApp({ SUPABASE_URL: SUPA, SUPABASE_SECRET_KEY: "sk", AI_FALLBACK_PROVIDER: "anthropic", AI_FALLBACK_API_KEY: "sk-teste", AI_FALLBACK_BASE_URL: CLAUDE });
    [fx, other] = await Promise.all([createAuthFixture(), createAuthFixture()]);
    [adminToken, agentToken, otherToken] = await Promise.all([
      accessTokenFor(app, fx.user.email, fx.b.id),
      accessTokenFor(app, fx.user.email, fx.a.id),
      accessTokenFor(app, other.user.email, other.b.id),
    ]);
  });

  afterAll(async () => {
    await redis.del(`ratelimit:menu-import-ai:${fx?.b.id}:${today}`, `ratelimit:menu-import-ai:${other?.b.id}:${today}`);
    await redis?.quit();
    await fx?.cleanup();
    await other?.cleanup();
    await app?.close();
    vi.unstubAllGlobals();
  });

  it("sem o módulo MENU é 403 e nada é enviado", async () => {
    await upload(fx.b.id, adminToken).expect(403);
    expect(stored.size).toBe(0);
  });

  describe("com o módulo ligado", () => {
    beforeAll(async () => {
      await Promise.all([enable(fx.a.id), enable(fx.b.id), enable(other.b.id)]);
    });

    it("lê a foto em segundo plano, mostra as linhas para revisar e nada é gravado antes do commit", async () => {
      const { body: started } = await upload(fx.b.id, adminToken).expect(202);
      expect([...stored.keys()][0]).toMatch(new RegExp(`^tenants/${fx.b.id}/import/[0-9a-f-]{36}\\.png$`));
      const done = await waitDone(fx.b.id, started.jobId);
      expect(done).toMatchObject({ status: "done", fileName: "cardápio balcão.png", mime: "image/png", fileUrl: `${SUPA}/storage/v1/object/sign/menu-private/x?token=t` });
      expect(done.counts).toEqual({ rows: 6, validRows: 5, invalidRows: 1, categories: 3, items: 4, sizes: 2 });
      expect(done.rows[1].ai.suggestions).toEqual([{ field: "item", value: "Portuguesa" }]);
      expect(claudeCalls).toBe(1);
      expect(await admin.menuItem.count({ where: { tenantId: fx.b.id } })).toBe(0);
      expect(await admin.aiUsage.count({ where: { tenantId: fx.b.id, model: "claude-sonnet-5-5" } })).toBe(1);

      // A revisão aceita a sugestão e corrige o preço; o check revalida sem gravar; o commit do CSV grava.
      const rows = done.rows.map((row: { line: number; item: string; priceCents: number | null }) =>
        row.line === 2 ? { ...row, item: "Portuguesa" } : row.line === 3 ? { ...row, priceCents: 3890 } : row,
      );
      const { body: checked } = await request(app.getHttpServer()).post(`/api/menu/${fx.b.id}/import/ai/check`).set("Authorization", `Bearer ${adminToken}`).send({ rows }).expect(200);
      expect(checked.counts).toMatchObject({ rows: 6, validRows: 6, items: 5 });
      expect(await admin.menuItem.count({ where: { tenantId: fx.b.id } })).toBe(0);
      const saved = await request(app.getHttpServer()).post(`/api/menu/${fx.b.id}/import/csv/commit`).set("Authorization", `Bearer ${adminToken}`).send({ rows }).expect(201);
      expect(saved.body).toEqual({ categories: 3, items: 5, sizes: 2 });
      expect(await admin.menuItem.findMany({ where: { tenantId: fx.b.id }, select: { name: true }, orderBy: { name: "asc" } })).toEqual(
        ["Calabresa", "Fondue", "Portuguesa", "Quatro queijos", "Suco"].map((name) => ({ name })),
      );
    });

    it("leitura de outro restaurante é 404; id que não existe também", async () => {
      const { body } = await upload(other.b.id, otherToken).expect(202);
      await waitDone(other.b.id, body.jobId, otherToken);
      await status(fx.b.id, body.jobId).expect(404);
      await status(fx.b.id, randomUUID()).expect(404);
      await status(other.b.id, body.jobId).expect(403); // o admin de B não é membro do outro restaurante
    });

    it("limite diário por restaurante, PDF com páginas demais e tipo errado", async () => {
      const key = `ratelimit:menu-import-ai:${fx.b.id}:${today}`;
      await redis.set(key, "10");
      const before = stored.size;
      const res = await upload(fx.b.id, adminToken).expect(429);
      expect(res.body.message).toMatch(/Limite de 10 leituras por dia/);
      expect(await redis.get(key)).toBe("10");
      await redis.del(key);
      const pdf = new TextEncoder().encode(`%PDF-1.4 ${"<< /Type /Page >> ".repeat(11)}`);
      expect((await upload(fx.b.id, adminToken, pdf, "application/pdf").expect(400)).body.message).toMatch(/mais de 10 páginas/);
      await upload(fx.b.id, adminToken, new Uint8Array([1]), "image/gif").expect(400);
      expect(stored.size).toBe(before);
    });

    it("atendente não importa; restaurante de fora é 403", async () => {
      await upload(fx.a.id, agentToken).expect(403);
      await upload(fx.c.id, adminToken).expect(403);
      await request(app.getHttpServer()).post(`/api/menu/${fx.a.id}/import/ai/check`).set("Authorization", `Bearer ${agentToken}`).send({ rows: toImportRows(EXTRACTION) }).expect(403);
    });
  });
});
