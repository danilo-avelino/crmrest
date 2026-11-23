import Anthropic from "@anthropic-ai/sdk";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { assertNotDemo } from "../demo/demo.js";
import { CLAUDE_PRICES } from "./llm.client.js";

/** Modelo do agente do cardápio (decisão D1). Um `model` na chamada troca por outro (ex.: claude-sonnet-5-5). */
export const LLM_PROVIDER_MODEL = "claude-haiku-5-5";

/** O que a ferramenta recebe do sistema, nunca do modelo. */
export type LlmToolContext = { tenantId: string };

export type LlmTool<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  inputSchema: S;
  handler: (input: z.infer<S>, ctx: LlmToolContext) => Promise<unknown> | unknown;
};

export type LlmChatMessage = { role: "user" | "assistant"; content: string };

export type LlmToolCall = { name: string; input: unknown; output: unknown; isError: boolean };

export type ChatWithToolsParams = {
  system: string;
  messages: LlmChatMessage[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: LlmTool<any>[];
  tenantId: string;
  /** Chamadas ao modelo antes de desistir. */
  maxIterations: number;
  maxTokens: number;
  /** Prazo de cada chamada ao modelo. */
  timeoutMs: number;
  toolChoice?: "auto" | "any" | "none" | { name: string };
  model?: string;
};

export type ChatWithToolsResult = {
  /** "done": o modelo terminou; "limit": bateu no maxIterations com ferramentas ainda pendentes. */
  outcome: "done" | "limit";
  text: string;
  toolCalls: LlmToolCall[];
  model: string;
  stopReason: string | null;
  /** Tokens somados das chamadas (entrada com as leituras e gravações do cache), para o teto por conversa. */
  usage: { inputTokens: number; outputTokens: number };
};

export interface LlmProvider {
  /** Há chave da API configurada. */
  readonly enabled: boolean;
  chatWithTools(params: ChatWithToolsParams): Promise<ChatWithToolsResult>;
}

/** Só o pedaço do SDK que o provedor usa (o teste troca por um mock). */
export type MessagesApi = Pick<Anthropic["messages"], "create">;

/** Gravações e leituras do cache do prompt custam 1,25x e 0,1x a entrada. */
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

/**
 * Chat com ferramentas na API do Claude (chave em AI_FALLBACK_API_KEY com AI_FALLBACK_PROVIDER=anthropic, como no
 * LlmClient). Executa os tool_use pelos handlers e devolve os resultados até o modelo terminar ou bater no teto. O
 * system e as ferramentas vão com cache_control para o cache do prompt. Cada chamada grava o uso em AiUsage.
 */
@Injectable()
export class AnthropicLlmProvider implements LlmProvider {
  private readonly logger = new Logger(AnthropicLlmProvider.name);
  private readonly messagesApi: MessagesApi | null;

  constructor(
    @Inject(ENV) env: Env,
    private readonly db: DatabaseService,
    messagesApi?: MessagesApi,
  ) {
    const key = env.AI_FALLBACK_PROVIDER === "anthropic" ? env.AI_FALLBACK_API_KEY : undefined;
    this.messagesApi = messagesApi ?? (key ? new Anthropic({ apiKey: key, baseURL: env.AI_FALLBACK_BASE_URL }).messages : null);
  }

  get enabled(): boolean {
    return !!this.messagesApi;
  }

  async chatWithTools(params: ChatWithToolsParams): Promise<ChatWithToolsResult> {
    if (!this.messagesApi) throw new Error("IA desligada: falta a chave da API do Claude.");
    await assertNotDemo(this.db, params.tenantId, "Agente com ferramentas");
    const model = params.model ?? LLM_PROVIDER_MODEL;
    const byName = new Map(params.tools.map((tool) => [tool.name, tool]));
    const tools: Anthropic.Tool[] = params.tools.map((tool, index) => {
      const { $schema: _, ...schema } = z.toJSONSchema(tool.inputSchema, { io: "input" });
      return {
        name: tool.name,
        description: tool.description,
        input_schema: schema as Anthropic.Tool.InputSchema,
        // O último bloco marcado põe system + ferramentas no cache.
        ...(index === params.tools.length - 1 && { cache_control: { type: "ephemeral" as const } }),
      };
    });
    const choice = params.toolChoice ?? "auto";
    const toolChoice: Anthropic.ToolChoice = typeof choice === "string" ? { type: choice } : { type: "tool", name: choice.name };
    const messages: Anthropic.MessageParam[] = params.messages.map((message) => ({ role: message.role, content: message.content }));
    const toolCalls: LlmToolCall[] = [];
    let text = "";
    let stopReason: string | null = null;
    const usage = { inputTokens: 0, outputTokens: 0 };

    for (let iteration = 0; iteration < params.maxIterations; iteration++) {
      const response = await this.messagesApi.create(
        {
          model,
          max_tokens: params.maxTokens,
          system: [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }],
          messages,
          ...(tools.length > 0 && { tools, tool_choice: toolChoice }),
        },
        { timeout: params.timeoutMs },
      );
      await this.recordUsage(params.tenantId, model, response.usage);
      usage.inputTokens += response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0);
      usage.outputTokens += response.usage.output_tokens;
      stopReason = response.stop_reason;
      text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      const uses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
      if (response.stop_reason !== "tool_use" || uses.length === 0) return { outcome: "done", text, toolCalls, model, stopReason, usage };

      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        const call = await this.runTool(byName.get(use.name), use, { tenantId: params.tenantId });
        toolCalls.push(call);
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: typeof call.output === "string" ? call.output : JSON.stringify(call.output ?? null),
          ...(call.isError && { is_error: true }),
        });
      }
      messages.push({ role: "user", content: results });
    }
    return { outcome: "limit", text, toolCalls, model, stopReason, usage };
  }

  private async runTool(tool: LlmTool | undefined, use: Anthropic.ToolUseBlock, ctx: LlmToolContext): Promise<LlmToolCall> {
    const fail = (output: string): LlmToolCall => ({ name: use.name, input: use.input, output, isError: true });
    if (!tool) return fail(`Ferramenta desconhecida: ${use.name}`);
    const parsed = tool.inputSchema.safeParse(use.input);
    if (!parsed.success) return fail(`Entrada inválida: ${z.prettifyError(parsed.error)}`);
    try {
      return { name: use.name, input: parsed.data, output: await tool.handler(parsed.data, ctx), isError: false };
    } catch (error) {
      return fail(`Erro: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Mesmo registro do LlmClient, com as leituras e gravações do cache somadas na entrada. Falha aqui não derruba a resposta. */
  private async recordUsage(tenantId: string, model: string, usage: Anthropic.Usage): Promise<void> {
    const price = CLAUDE_PRICES[model];
    if (!price) this.logger.warn(`Sem preço para o modelo ${model}: o gasto fica registrado só em tokens.`);
    const written = usage.cache_creation_input_tokens ?? 0;
    const read = usage.cache_read_input_tokens ?? 0;
    const costMicroUsd = price
      ? Math.round((usage.input_tokens + written * CACHE_WRITE + read * CACHE_READ) * price.input + usage.output_tokens * price.output)
      : 0;
    try {
      await this.db.withTenants({ tenantIds: [tenantId] }, (tx) =>
        tx.aiUsage.create({
          data: {
            tenantId,
            provider: "CLAUDE",
            model,
            inputTokens: usage.input_tokens + written + read,
            outputTokens: usage.output_tokens,
            costMicroUsd,
          },
          select: { id: true },
        }),
      );
    } catch (error) {
      this.logger.warn(`Uso da IA não registrado: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
