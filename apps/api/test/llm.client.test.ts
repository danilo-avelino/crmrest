import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmClient } from "../src/ai/llm.client.js";
import type { Env } from "../src/config/env.js";
import type { DatabaseService } from "../src/core/database.service.js";
import { startMockGraph } from "./helpers.js";

const Answer = z.object({ text: z.string() });
const TENANT = "019a0000-0000-7000-8000-000000000001";
const ok = (text: string) => ({ status: 200, body: { choices: [{ message: { content: JSON.stringify({ text }) } }] } });

describe("LlmClient: LLM reserva", () => {
  let main: Awaited<ReturnType<typeof startMockGraph>>;
  let backup: Awaited<ReturnType<typeof startMockGraph>>;
  const env = () =>
    ({
      AI_BASE_URL: main.url,
      AI_API_KEY: "chave-principal",
      AI_MODEL: "gemma4:12b",
      AI_TIMEOUT_MS: 5_000,
      AI_FALLBACK_PROVIDER: "openai",
      AI_FALLBACK_BASE_URL: backup.url,
      AI_FALLBACK_API_KEY: "chave-reserva",
      AI_FALLBACK_MODEL: "qwen3.5:4b",
      AI_FALLBACK_TIMEOUT_MS: 5_000,
    }) as Env;

  // O banco só recebe os gastos com o Claude: guarda o que seria gravado.
  const usages: { tenantIds: string[]; data: unknown }[] = [];
  const db = {
    withTenants: (scope: { tenantIds: string[] }, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ aiUsage: { create: ({ data }: { data: unknown }) => usages.push({ tenantIds: scope.tenantIds, data }) } }),
  } as unknown as DatabaseService;

  beforeAll(async () => {
    main = await startMockGraph();
    backup = await startMockGraph();
  });
  afterAll(async () => {
    await main?.close();
    await backup?.close();
  });
  beforeEach(() => {
    main.requests.length = 0;
    backup.requests.length = 0;
    usages.length = 0;
    main.reply(() => ok("principal"));
    backup.reply(() => ok("reserva"));
  });

  it("com a principal no ar, a reserva não é chamada", async () => {
    const llm = new LlmClient(env(), db);
    expect(await llm.answer(TENANT, "teste", Answer, [{ role: "user", content: "oi" }])).toEqual({ result: { text: "principal" }, model: "gemma4:12b" });
    expect(backup.requests).toHaveLength(0);
    expect(usages).toHaveLength(0); // a LLM local não entra nos gastos
  });

  it("com a principal em erro HTTP (ex.: túnel do ngrok sem o PC), a reserva responde com o modelo e a chave dela", async () => {
    main.reply(() => ({ status: 502, body: {} }));
    const llm = new LlmClient(env(), db);
    expect(await llm.answer(TENANT, "teste", Answer, [{ role: "user", content: "oi" }])).toEqual({ result: { text: "reserva" }, model: "qwen3.5:4b" });
    expect(backup.requests[0]).toMatchObject({ authorization: "Bearer chave-reserva", body: { model: "qwen3.5:4b" } });
  });

  it("com a principal fora da rede, a reserva responde", async () => {
    const llm = new LlmClient({ ...env(), AI_BASE_URL: "http://127.0.0.1:1" }, db);
    expect(await llm.json(TENANT, "teste", Answer, [{ role: "user", content: "oi" }])).toEqual({ text: "reserva" });
  });

  it("um JSON quebrado da principal é pedido de novo a ela, não à reserva", async () => {
    let calls = 0;
    main.reply(() => (++calls === 1 ? { status: 200, body: { choices: [{ message: { content: "{quebrado" } }] } } : ok("principal")));
    const llm = new LlmClient(env(), db);
    expect(await llm.json(TENANT, "teste", Answer, [{ role: "user", content: "oi" }])).toEqual({ text: "principal" });
    expect(backup.requests).toHaveLength(0);
  });

  it("sem reserva, o erro da principal sobe", async () => {
    main.reply(() => ({ status: 500, body: {} }));
    const llm = new LlmClient({ ...env(), AI_FALLBACK_BASE_URL: undefined }, db);
    await expect(llm.json(TENANT, "teste", Answer, [{ role: "user", content: "oi" }])).rejects.toThrow("HTTP 500");
  });

  it("reserva no Claude: manda o prompt do sistema à parte, o schema na saída estruturada e sem temperatura", async () => {
    main.reply(() => ({ status: 502, body: {} }));
    backup.reply(() => ({
      status: 200,
      body: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [{ type: "text", text: JSON.stringify({ text: "  claude  " }) }],
        stop_reason: "end_turn",
        stop_details: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }));
    const llm = new LlmClient({ ...env(), AI_FALLBACK_PROVIDER: "anthropic", AI_FALLBACK_MODEL: "claude-haiku-5-5" }, db);
    const Trimmed = z.object({ text: z.string().trim().min(1) });
    const answer = await llm.answer(TENANT, "teste", Trimmed, [
      { role: "system", content: "regras" },
      { role: "user", content: "oi" },
    ]);
    expect(answer).toEqual({ result: { text: "claude" }, model: "claude-haiku-5-5" });
    const sent = backup.requests[0]!;
    expect(sent.path).toBe("/v1/messages");
    expect(sent.body).toMatchObject({ model: "claude-haiku-5-5", system: "regras", messages: [{ role: "user", content: "oi" }] });
    expect(sent.body).not.toHaveProperty("temperature");
    expect((sent.body as { output_config: { format: { type: string } } }).output_config.format.type).toBe("json_schema");
    // Haiku 5.5: 10 tokens de entrada a US$ 0,10 e 5 de saída a US$ 0,50 por milhão = 3,5 milionésimos de dólar, arredondados para 4.
    expect(usages).toEqual([
      { tenantIds: [TENANT], data: { tenantId: TENANT, model: "claude-haiku-5-5", inputTokens: 10, outputTokens: 5, costMicroUsd: 4 } },
    ]);
  });

  it("reserva no Claude: uma recusa vira erro", async () => {
    main.reply(() => ({ status: 502, body: {} }));
    backup.reply(() => ({
      status: 200,
      body: {
        id: "msg_2",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: null, explanation: null },
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    }));
    const llm = new LlmClient({ ...env(), AI_FALLBACK_PROVIDER: "anthropic", AI_FALLBACK_MODEL: "claude-haiku-5-5" }, db);
    await expect(llm.json(TENANT, "teste", Answer, [{ role: "user", content: "oi" }])).rejects.toThrow("recusou");
    expect(usages).toHaveLength(1); // a recusa também é cobrada
  });

  it("status: a principal no ar com um chat de um token; o Claude pela consulta do modelo, sem gastar tokens", async () => {
    backup.reply((req) =>
      req.path === "/v1/models/claude-haiku-5-5"
        ? { status: 200, body: { id: "claude-haiku-5-5", type: "model", display_name: "Claude Haiku 5.5", created_at: "2026-01-01T00:00:00Z" } }
        : { status: 404, body: {} },
    );
    const llm = new LlmClient({ ...env(), AI_FALLBACK_PROVIDER: "anthropic", AI_FALLBACK_MODEL: "claude-haiku-5-5" }, db);
    expect(await llm.status()).toMatchObject({
      main: { model: "gemma4:12b", online: true },
      fallback: { provider: "anthropic", model: "claude-haiku-5-5", online: true },
    });
    expect(main.requests[0]).toMatchObject({ authorization: "Bearer chave-principal", body: { max_tokens: 1 } });
    expect(backup.requests.map((req) => req.method)).toEqual(["GET"]);
  });

  it("status: a principal fora do ar e a reserva no ar; sem reserva, ela vem null", async () => {
    main.reply(() => ({ status: 502, body: {} }));
    expect(await new LlmClient(env(), db).status()).toMatchObject({ main: { online: false }, fallback: { provider: "openai", online: true } });
    expect(await new LlmClient({ ...env(), AI_FALLBACK_BASE_URL: undefined }, db).status()).toMatchObject({ main: { online: false }, fallback: null });
  });

  it("com as duas fora do ar, o erro da reserva sobe", async () => {
    main.reply(() => ({ status: 500, body: {} }));
    backup.reply(() => ({ status: 503, body: {} }));
    const llm = new LlmClient(env(), db);
    await expect(llm.json(TENANT, "teste", Answer, [{ role: "user", content: "oi" }])).rejects.toThrow("HTTP 503");
  });
});
