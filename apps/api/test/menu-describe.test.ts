import type { INestApplication } from "@nestjs/common";
import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { aiFieldsPrompt, sanitizeAiFields } from "../src/menu/menu-ai-fields.js";
import { cleanSuggestion, describePrompt } from "../src/menu/menu-describe.js";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

const CLAUDE = "https://claude.teste";
const usage = { input_tokens: 400, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

describe("Melhorar com IA na descrição do item (F2-15): texto", () => {
  it("o prompt leva só o que o formulário tem", () => {
    expect(describePrompt({ name: "Calabresa" })).toBe("Nome: Calabresa\nDescrição atual: (vazia)\n\nEscreva a nova descrição.");
    expect(describePrompt({ name: "Calabresa", categoryName: "Pizzas", ingredients: ["linguiça", "cebola"], tags: ["tradicional"], servesPeople: 2, description: "Pizza simples" })).toBe(
      "Nome: Calabresa\nCategoria: Pizzas\nIngredientes: linguiça, cebola\nEtiquetas: tradicional\nServe: 2 pessoas\nDescrição atual: Pizza simples\n\nEscreva a nova descrição.",
    );
  });

  it("limpa aspas e espaços; vazio ou acima de 2000 vira null", () => {
    expect(cleanSuggestion('  "Linguiça e cebola\n  na massa fina."  ')).toBe("Linguiça e cebola na massa fina.");
    expect(cleanSuggestion("   ")).toBeNull();
    expect(cleanSuggestion("a".repeat(2001))).toBeNull();
    expect(cleanSuggestion("a".repeat(2000))).toHaveLength(2000);
  });
});

describe("Preencher com IA na aba Para a IA (F2-15): texto", () => {
  const output = { ingredients: [" calabresa ", "Calabresa", "", "cebola"], synonyms: ["calab"], tags: ["picante"], allergens: ["glúten", "Mel", "LEITE"], servesPeople: 2, aiNotes: " Sugerir borda. ", pairsWith: ["a", "x", "a"] };

  it("alérgeno fora da lista e item que não é do restaurante são descartados", () => {
    expect(sanitizeAiFields(output, new Set(["a"]))).toEqual({
      ingredients: ["calabresa", "cebola"],
      synonyms: ["calab"],
      tags: ["picante"],
      allergens: ["Glúten", "Leite"],
      servesPeople: 2,
      aiNotes: "Sugerir borda.",
      pairsWith: ["a"],
    });
    expect(sanitizeAiFields({ ...output, servesPeople: 0, aiNotes: "  " }, new Set())).toMatchObject({ servesPeople: null, aiNotes: null, pairsWith: [] });
  });

  it("o prompt lista os outros itens com id", () => {
    expect(aiFieldsPrompt({ name: "Calabresa", sizes: [{ name: "Grande" }] }, [{ id: "i1", name: "Guaraná", categoryName: "Bebidas" }])).toBe(
      "Nome: Calabresa\nDescrição: (vazia)\nTamanhos: Grande\n\nOutros itens do cardápio (id | nome | categoria):\ni1 | Guaraná | Bebidas",
    );
  });
});

describe("Melhorar com IA na descrição do item (F2-15): API", () => {
  const realFetch = globalThis.fetch;
  // O que o "Claude" falso responde; cada chamada tira a primeira.
  let texts: string[] = [];
  const requests: { model: string; system: string; messages: { content: string }[] }[] = [];
  let app: INestApplication;
  let appNoKey: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let adminToken: string; // administrador em B
  let agentToken: string; // atendente em A
  let noKeyToken: string;
  let redis: Redis;
  const today = new Date().toISOString().slice(0, 10);
  const enable = (tenantId: string) => admin.tenantModule.upsert({ where: { tenantId_module: { tenantId, module: "MENU" } }, create: { tenantId, module: "MENU" }, update: {} });
  const describeItem = (tenantId: string, token: string, body: unknown = { name: "Calabresa", ingredients: ["linguiça", "cebola"], categoryName: "Pizzas" }, server = app) =>
    request(server.getHttpServer()).post(`/api/menu/${tenantId}/items/describe`).set("Authorization", `Bearer ${token}`).send(body as object);
  const usages = () => admin.aiUsage.findMany({ where: { tenantId: fx.b.id, model: "claude-haiku-5-5" } });

  beforeAll(async () => {
    redis = new Redis(loadEnv(process.env).REDIS_URL);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      if (!url.startsWith(CLAUDE)) return realFetch(input, init);
      requests.push(JSON.parse(init.body as string));
      const text = texts.shift() ?? "Texto padrão.";
      return new Response(
        JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", usage }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    app = await createTestApp({ AI_FALLBACK_PROVIDER: "anthropic", AI_FALLBACK_API_KEY: "sk-teste", AI_FALLBACK_BASE_URL: CLAUDE });
    appNoKey = await createTestApp({ AI_FALLBACK_PROVIDER: "openai" });
    fx = await createAuthFixture();
    [adminToken, agentToken, noKeyToken] = await Promise.all([
      accessTokenFor(app, fx.user.email, fx.b.id),
      accessTokenFor(app, fx.user.email, fx.a.id),
      accessTokenFor(appNoKey, fx.user.email, fx.b.id),
    ]);
  });

  afterAll(async () => {
    await redis.del(`ratelimit:menu-describe:${fx?.b.id}:${today}`);
    await redis?.quit();
    await fx?.cleanup();
    await app?.close();
    await appNoKey?.close();
    vi.unstubAllGlobals();
  });

  it("sem o módulo MENU é 403 e o Claude não é chamado", async () => {
    await describeItem(fx.b.id, adminToken).expect(403);
    await request(app.getHttpServer()).post(`/api/menu/${fx.b.id}/items/ai-fields`).set("Authorization", `Bearer ${adminToken}`).send({ name: "Calabresa" }).expect(403);
    expect(requests).toHaveLength(0);
  });

  describe("com o módulo ligado", () => {
    beforeAll(async () => {
      await Promise.all([enable(fx.a.id), enable(fx.b.id)]);
    });

    it("devolve a sugestão, usa o Haiku 5.5 com os dados do formulário e grava o custo em AiUsage", async () => {
      texts = ['"Pizza de calabresa com cebola, na massa da casa."'];
      const { body } = await describeItem(fx.b.id, adminToken, { name: "Calabresa", ingredients: ["linguiça", "cebola"], categoryName: "Pizzas", servesPeople: 2, description: "" }).expect(200);
      expect(body).toEqual({ suggestion: "Pizza de calabresa com cebola, na massa da casa." });
      expect(requests[0]!.model).toBe("claude-haiku-5-5");
      expect(requests[0]!.system).toContain("NUNCA invente");
      expect(requests[0]!.messages[0]!.content).toBe(
        "Nome: Calabresa\nCategoria: Pizzas\nIngredientes: linguiça, cebola\nServe: 2 pessoas\nDescrição atual: (vazia)\n\nEscreva a nova descrição.",
      );
      // 400 de entrada a US$ 0,10 e 60 de saída a US$ 0,50 por milhão = 70 milionésimos de dólar.
      expect(await usages()).toEqual([expect.objectContaining({ provider: "CLAUDE", inputTokens: 400, outputTokens: 60, costMicroUsd: 70 })]);
    });

    it("resposta acima de 2000 caracteres tenta de novo uma vez; duas vezes dá 502 sem consumir o limite", async () => {
      const before = (await usages()).length;
      texts = ["a".repeat(2001), "Linguiça e cebola."];
      await describeItem(fx.b.id, adminToken).expect(200, { suggestion: "Linguiça e cebola." });
      expect((await usages()).length).toBe(before + 2);

      texts = ["b".repeat(2001), "c".repeat(2001)];
      const used = Number(await redis.get(`ratelimit:menu-describe:${fx.b.id}:${today}`));
      const failed = await describeItem(fx.b.id, adminToken).expect(502);
      expect(failed.body.message).toBe("Não foi possível gerar a sugestão agora. Tente de novo em instantes.");
      expect(Number(await redis.get(`ratelimit:menu-describe:${fx.b.id}:${today}`))).toBe(used);
    });

    it("nome vazio ou campo grande demais é 400", async () => {
      await describeItem(fx.b.id, adminToken, { name: "  " }).expect(400);
      await describeItem(fx.b.id, adminToken, { name: "X", description: "a".repeat(2001) }).expect(400);
    });

    it("atendente não gera sugestão", async () => {
      const calls = requests.length;
      await describeItem(fx.a.id, agentToken).expect(403);
      expect(requests).toHaveLength(calls);
    });

    it("sem a chave do Claude é 503 com a mensagem em português", async () => {
      const { body } = await describeItem(fx.b.id, noKeyToken, undefined, appNoKey).expect(503);
      expect(body.message).toBe("A IA não está configurada neste ambiente.");
    });

    describe("Preencher com IA", () => {
      const fields = (tenantId: string, token: string, body: unknown = { name: "Calabresa", categoryName: "Pizzas" }, server = app) =>
        request(server.getHttpServer()).post(`/api/menu/${tenantId}/items/ai-fields`).set("Authorization", `Bearer ${token}`).send(body as object);
      const seed = async (tenantId: string, name: string) => {
        const menu = await admin.menu.upsert({ where: { tenantId }, create: { tenantId, name: "Cardápio" }, update: {} });
        const category = await admin.menuCategory.create({ data: { tenantId, menuId: menu.id, name: "Bebidas" } });
        return admin.menuItem.create({ data: { tenantId, categoryId: category.id, name, priceCents: 900 } });
      };

      it("preenche os campos; combina com só aceita item do próprio restaurante e alérgeno só da lista", async () => {
        const own = await seed(fx.b.id, "Guaraná");
        const foreign = await seed(fx.a.id, "Suco de outro");
        texts = [
          JSON.stringify({
            ingredients: ["calabresa", "cebola"],
            synonyms: ["calab", "pizza de linguiça"],
            tags: [],
            allergens: ["Glúten", "Mel"],
            servesPeople: null,
            aiNotes: "Sugerir borda recheada.",
            pairsWith: [own.id, foreign.id, "inexistente"],
          }),
        ];
        const before = (await usages()).length;
        const { body } = await fields(fx.b.id, adminToken).expect(200);
        expect(body).toEqual({
          ingredients: ["calabresa", "cebola"],
          synonyms: ["calab", "pizza de linguiça"],
          tags: [],
          allergens: ["Glúten"],
          servesPeople: null,
          aiNotes: "Sugerir borda recheada.",
          pairsWith: [own.id],
        });
        const sent = requests.at(-1)!;
        expect(sent.model).toBe("claude-haiku-5-5");
        expect(sent.messages[0]!.content).toContain(`${own.id} | Guaraná | Bebidas`);
        expect(sent.messages[0]!.content).not.toContain(foreign.id);
        expect((await usages()).length).toBe(before + 1);
      });

      it("resposta fora do formato tenta de novo; atendente, nome vazio e sem chave seguem as mesmas regras", async () => {
        texts = ["não é json", JSON.stringify({ ingredients: [], synonyms: [], tags: [], allergens: [], servesPeople: 4, aiNotes: null, pairsWith: [] })];
        await fields(fx.b.id, adminToken).expect(200);
        await fields(fx.a.id, agentToken).expect(403);
        await fields(fx.b.id, adminToken, { name: " " }).expect(400);
        const { body } = await fields(fx.b.id, noKeyToken, undefined, appNoKey).expect(503);
        expect(body.message).toBe("A IA não está configurada neste ambiente.");
      });
    });

    it("passou de 200 por dia no restaurante é 429, sem chamar o Claude", async () => {
      await redis.set(`ratelimit:menu-describe:${fx.b.id}:${today}`, "200", "EX", 3600);
      const calls = requests.length;
      const { body } = await describeItem(fx.b.id, adminToken).expect(429);
      expect(body.message).toBe("Limite de 200 sugestões por dia atingido. Tente amanhã.");
      expect(requests).toHaveLength(calls);
    });
  });
});
