import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmClient } from "../src/ai/llm.client.js";
import type { Env } from "../src/config/env.js";
import { startMockGraph } from "./helpers.js";

const Answer = z.object({ text: z.string() });
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
      AI_FALLBACK_BASE_URL: backup.url,
      AI_FALLBACK_API_KEY: "chave-reserva",
      AI_FALLBACK_MODEL: "qwen3.5:4b",
      AI_FALLBACK_TIMEOUT_MS: 5_000,
    }) as Env;

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
    main.reply(() => ok("principal"));
    backup.reply(() => ok("reserva"));
  });

  it("com a principal no ar, a reserva não é chamada", async () => {
    const llm = new LlmClient(env());
    expect(await llm.answer("teste", Answer, [{ role: "user", content: "oi" }])).toEqual({ result: { text: "principal" }, model: "gemma4:12b" });
    expect(backup.requests).toHaveLength(0);
  });

  it("com a principal em erro HTTP (ex.: túnel do ngrok sem o PC), a reserva responde com o modelo e a chave dela", async () => {
    main.reply(() => ({ status: 502, body: {} }));
    const llm = new LlmClient(env());
    expect(await llm.answer("teste", Answer, [{ role: "user", content: "oi" }])).toEqual({ result: { text: "reserva" }, model: "qwen3.5:4b" });
    expect(backup.requests[0]).toMatchObject({ authorization: "Bearer chave-reserva", body: { model: "qwen3.5:4b" } });
  });

  it("com a principal fora da rede, a reserva responde", async () => {
    const llm = new LlmClient({ ...env(), AI_BASE_URL: "http://127.0.0.1:1" });
    expect(await llm.json("teste", Answer, [{ role: "user", content: "oi" }])).toEqual({ text: "reserva" });
  });

  it("um JSON quebrado da principal é pedido de novo a ela, não à reserva", async () => {
    let calls = 0;
    main.reply(() => (++calls === 1 ? { status: 200, body: { choices: [{ message: { content: "{quebrado" } }] } } : ok("principal")));
    const llm = new LlmClient(env());
    expect(await llm.json("teste", Answer, [{ role: "user", content: "oi" }])).toEqual({ text: "principal" });
    expect(backup.requests).toHaveLength(0);
  });

  it("sem reserva, o erro da principal sobe", async () => {
    main.reply(() => ({ status: 500, body: {} }));
    const llm = new LlmClient({ ...env(), AI_FALLBACK_BASE_URL: undefined });
    await expect(llm.json("teste", Answer, [{ role: "user", content: "oi" }])).rejects.toThrow("HTTP 500");
  });

  it("com as duas fora do ar, o erro da reserva sobe", async () => {
    main.reply(() => ({ status: 500, body: {} }));
    backup.reply(() => ({ status: 503, body: {} }));
    const llm = new LlmClient(env());
    await expect(llm.json("teste", Answer, [{ role: "user", content: "oi" }])).rejects.toThrow("HTTP 503");
  });
});
