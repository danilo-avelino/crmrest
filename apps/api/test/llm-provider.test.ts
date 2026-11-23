import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicLlmProvider, type LlmTool, type MessagesApi } from "../src/ai/llm-provider.js";
import type { Env } from "../src/config/env.js";
import type { DatabaseService } from "../src/core/database.service.js";

const TENANT = "019a0000-0000-7000-8000-000000000001";
const usage = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const text = (value: string) => ({ content: [{ type: "text", text: value }], stop_reason: "end_turn", usage });
const toolUse = (id: string, name: string, input: unknown) => ({
  content: [{ type: "tool_use", id, name, input }],
  stop_reason: "tool_use",
  usage,
});

describe("AnthropicLlmProvider: chat com ferramentas", () => {
  const usages: unknown[] = [];
  const db = {
    withTenants: (_scope: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      // tenant: a guarda da conta de demonstração lê a marca do restaurante (aqui, um restaurante comum).
      fn({ aiUsage: { create: ({ data }: { data: unknown }) => usages.push(data) }, tenant: { findUnique: async () => null } }),
  } as unknown as DatabaseService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let requests: any[];
  let replies: unknown[];
  const api = { create: async (body: unknown) => (requests.push(structuredClone(body)), replies.shift()) } as unknown as MessagesApi;
  const provider = () => new AnthropicLlmProvider({} as Env, db, api);

  const seen: unknown[] = [];
  const buscar: LlmTool<z.ZodObject<{ termo: z.ZodString }>> = {
    name: "buscar_cardapio",
    description: "Busca itens",
    inputSchema: z.object({ termo: z.string() }),
    handler: (input, ctx) => (seen.push(ctx), { itens: [`${input.termo} grande`] }),
  };
  const base = { system: "Você é o atendente.", tenantId: TENANT, maxIterations: 4, maxTokens: 500, timeoutMs: 10_000 };

  beforeEach(() => {
    requests = [];
    replies = [];
    usages.length = 0;
    seen.length = 0;
  });

  it("uma rodada de ferramenta: executa, devolve o resultado e termina", async () => {
    replies = [toolUse("t1", "buscar_cardapio", { termo: "pizza", tenantId: "outro" }), text("Temos pizza grande.")];
    const result = await provider().chatWithTools({ ...base, messages: [{ role: "user", content: "tem pizza?" }], tools: [buscar] });
    expect(result).toMatchObject({ outcome: "done", text: "Temos pizza grande.", model: "claude-haiku-5-5" });
    expect(result.toolCalls).toEqual([{ name: "buscar_cardapio", input: { termo: "pizza" }, output: { itens: ["pizza grande"] }, isError: false }]);
    // O tenantId vem do chamador, nunca do modelo.
    expect(seen).toEqual([{ tenantId: TENANT }]);
    expect(requests[1].messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", content: '{"itens":["pizza grande"]}' });
    // Cache do prompt no system e na última ferramenta.
    expect(requests[0].system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(requests[0].tools[0]).toMatchObject({ name: "buscar_cardapio", cache_control: { type: "ephemeral" } });
    expect(requests[0].tools[0].input_schema).toMatchObject({ type: "object", properties: { termo: { type: "string" } } });
  });

  it("várias iterações e troca de modelo", async () => {
    replies = [toolUse("a", "buscar_cardapio", { termo: "x" }), toolUse("b", "buscar_cardapio", { termo: "y" }), text("ok")];
    const result = await provider().chatWithTools({ ...base, model: "claude-sonnet-5-5", messages: [{ role: "user", content: "oi" }], tools: [buscar] });
    expect(result.outcome).toBe("done");
    expect(result.toolCalls.map((call) => call.input)).toEqual([{ termo: "x" }, { termo: "y" }]);
    expect(requests.map((request) => request.model)).toEqual(Array(3).fill("claude-sonnet-5-5"));
  });

  it("entrada inválida e erro do handler voltam como is_error", async () => {
    const quebra: LlmTool<z.ZodObject<{}>> = { name: "quebra", description: "", inputSchema: z.object({}), handler: () => { throw new Error("fora"); } };
    replies = [
      { content: [{ type: "tool_use", id: "1", name: "buscar_cardapio", input: { termo: 3 } }, { type: "tool_use", id: "2", name: "quebra", input: {} }], stop_reason: "tool_use", usage },
      text("desculpe"),
    ];
    const result = await provider().chatWithTools({ ...base, messages: [{ role: "user", content: "oi" }], tools: [buscar, quebra] });
    expect(result.toolCalls.map((call) => call.isError)).toEqual([true, true]);
    const [invalid, failed] = requests[1].messages[2].content;
    expect(invalid).toMatchObject({ is_error: true, tool_use_id: "1" });
    expect(invalid.content).toContain("Entrada inválida");
    expect(failed).toMatchObject({ is_error: true, content: "Erro: fora" });
    expect(seen).toHaveLength(0);
  });

  it("bate no maxIterations e devolve limit", async () => {
    replies = [toolUse("a", "buscar_cardapio", { termo: "x" }), toolUse("b", "buscar_cardapio", { termo: "y" })];
    const result = await provider().chatWithTools({ ...base, maxIterations: 2, messages: [{ role: "user", content: "oi" }], tools: [buscar] });
    expect(result.outcome).toBe("limit");
    expect(requests).toHaveLength(2);
    expect(result.toolCalls).toHaveLength(2);
  });

  it("grava o custo de cada chamada, com o cache", async () => {
    replies = [{ ...text("oi"), usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000 } }];
    await provider().chatWithTools({ ...base, messages: [{ role: "user", content: "oi" }], tools: [buscar] });
    // (1000 + 2000×1,25 + 10000×0,1) × 0,1 + 200 × 0,5 = 550 milionésimos de dólar
    expect(usages).toEqual([
      { tenantId: TENANT, provider: "CLAUDE", model: "claude-haiku-5-5", inputTokens: 13_000, outputTokens: 200, costMicroUsd: 550 },
    ]);
  });
});
