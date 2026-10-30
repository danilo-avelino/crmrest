import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { TenantTx } from "@dishdesk/database";
import type { PlatformAiStatusDto } from "@dishdesk/shared";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { ENV, type Env } from "../config/env.js";

export type LlmMessage = { role: "system" | "user"; content: string };

/** Respostas fora do formato (JSON inválido ou fora do schema) antes de desistir. */
const PARSE_ATTEMPTS = 2;
/** Quanto o painel da plataforma espera cada LLM responder ao conferir se está no ar. */
const PING_TIMEOUT_MS = 15_000;

type Endpoint =
  | { provider: "openai"; base: string; apiKey?: string; model: string; timeoutMs: number }
  | { provider: "anthropic"; client: Anthropic; model: string };

/**
 * LLM do módulo Atendimento com IA (AI_BASE_URL), no formato da OpenAI: o Ollama local ou um provedor. A resposta vem
 * em JSON no formato do schema e é validada por ele. Com a principal fora do ar, a chamada vai para a reserva
 * (AI_FALLBACK_*), se houver: outro endpoint no formato da OpenAI ou a API do Claude.
 */
@Injectable()
export class LlmClient {
  private readonly logger = new Logger(LlmClient.name);
  private readonly fallback: Endpoint | null;

  constructor(@Inject(ENV) private readonly env: Env) {
    const model = env.AI_FALLBACK_MODEL ?? env.AI_MODEL;
    if (env.AI_FALLBACK_PROVIDER === "anthropic") {
      this.fallback = env.AI_FALLBACK_API_KEY
        ? {
            provider: "anthropic",
            client: new Anthropic({ apiKey: env.AI_FALLBACK_API_KEY, baseURL: env.AI_FALLBACK_BASE_URL, timeout: env.AI_FALLBACK_TIMEOUT_MS }),
            model,
          }
        : null;
    } else {
      this.fallback = env.AI_FALLBACK_BASE_URL
        ? { provider: "openai", base: env.AI_FALLBACK_BASE_URL, apiKey: env.AI_FALLBACK_API_KEY, model, timeoutMs: env.AI_FALLBACK_TIMEOUT_MS }
        : null;
    }
  }

  /** O restaurante tem o módulo Atendimento com IA e a API tem uma LLM configurada. */
  async activeFor(tx: TenantTx, tenantId: string): Promise<boolean> {
    if (!this.env.AI_BASE_URL) return false;
    const module = await tx.tenantModule.findUnique({ where: { tenantId_module: { tenantId, module: "AI" } }, select: { id: true } });
    return !!module;
  }

  /** Confere agora se a principal e a reserva respondem (painel da plataforma). */
  async status(): Promise<PlatformAiStatusDto> {
    const main = this.env.AI_BASE_URL;
    const [mainOnline, fallbackOnline] = await Promise.all([
      main ? this.ping({ provider: "openai", base: main, apiKey: this.env.AI_API_KEY, model: this.env.AI_MODEL, timeoutMs: this.env.AI_TIMEOUT_MS }) : false,
      this.fallback ? this.ping(this.fallback) : false,
    ]);
    return {
      main: main ? { model: this.env.AI_MODEL, online: mainOnline } : null,
      fallback: this.fallback ? { provider: this.fallback.provider, model: this.fallback.model, online: fallbackOnline } : null,
      checkedAt: new Date().toISOString(),
    };
  }

  /** O Claude: consulta o modelo (não gasta tokens). O formato da OpenAI: um chat de um token. */
  private async ping(endpoint: Endpoint): Promise<boolean> {
    try {
      if (endpoint.provider === "anthropic") {
        await endpoint.client.models.retrieve(endpoint.model, null, { timeout: PING_TIMEOUT_MS, maxRetries: 0 });
        return true;
      }
      const response = await fetch(`${endpoint.base.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(endpoint.apiKey && { authorization: `Bearer ${endpoint.apiKey}` }) },
        body: JSON.stringify({ model: endpoint.model, messages: [{ role: "user", content: "ok" }], max_tokens: 1, reasoning_effort: "none" }),
        signal: AbortSignal.timeout(Math.min(endpoint.timeoutMs, PING_TIMEOUT_MS)),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async json<T>(name: string, schema: z.ZodType<T>, messages: LlmMessage[], temperature = 0.3): Promise<T> {
    return (await this.answer(name, schema, messages, temperature)).result;
  }

  /** Como json, dizendo também qual modelo respondeu (o da principal ou o da reserva). */
  async answer<T>(name: string, schema: z.ZodType<T>, messages: LlmMessage[], temperature = 0.3): Promise<{ result: T; model: string }> {
    const main = this.env.AI_BASE_URL;
    if (!main) throw new Error("IA desligada: falta AI_BASE_URL.");
    const endpoints: Endpoint[] = [
      { provider: "openai", base: main, apiKey: this.env.AI_API_KEY, model: this.env.AI_MODEL, timeoutMs: this.env.AI_TIMEOUT_MS },
      ...(this.fallback ? [this.fallback] : []),
    ];
    // O modelo local às vezes devolve um JSON quebrado (vírgula sobrando, texto cortado): pede de novo antes de desistir.
    for (let attempt = 1; ; attempt++) {
      const { content, model } = await this.completeAny(endpoints, name, schema, messages, temperature);
      try {
        return { result: schema.parse(JSON.parse(content)), model };
      } catch (error) {
        if (attempt >= PARSE_ATTEMPTS) throw error;
      }
    }
  }

  /** A principal; se ela não responder (rede, prazo ou erro HTTP), a reserva. */
  private async completeAny<T>(
    endpoints: Endpoint[],
    name: string,
    schema: z.ZodType<T>,
    messages: LlmMessage[],
    temperature: number,
  ): Promise<{ content: string; model: string }> {
    for (const [index, endpoint] of endpoints.entries()) {
      try {
        const content =
          endpoint.provider === "anthropic" ? await this.completeClaude(endpoint, schema, messages) : await this.complete(endpoint, name, schema, messages, temperature);
        return { content, model: endpoint.model };
      } catch (error) {
        if (index === endpoints.length - 1) throw error;
        this.logger.warn(`LLM principal sem resposta (${error instanceof Error ? error.message : String(error)}): usando a reserva`);
      }
    }
    throw new Error("A LLM não respondeu.");
  }

  /**
   * A API do Claude, com a saída no formato do schema (o SDK tira do schema as restrições que a API não aceita, como
   * tamanho mínimo, e as confere aqui). Sem temperatura: os modelos atuais recusam outro valor que não o padrão.
   * Esforço baixo: as tarefas são respostas curtas, e o esforço é o que mais pesa no tempo e no custo.
   */
  private async completeClaude<T>(endpoint: Extract<Endpoint, { provider: "anthropic" }>, schema: z.ZodType<T>, messages: LlmMessage[]): Promise<string> {
    const response = await endpoint.client.messages.parse({
      model: endpoint.model,
      max_tokens: 16000,
      system: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n") || undefined,
      messages: messages.filter((message) => message.role === "user").map((message) => ({ role: "user", content: message.content })),
      output_config: { effort: "low", format: zodOutputFormat(schema) },
    });
    if (response.stop_reason === "refusal") throw new Error(`O Claude recusou (${response.stop_details?.category ?? "sem categoria"}).`);
    if (response.parsed_output == null) throw new Error("A LLM não respondeu.");
    return JSON.stringify(response.parsed_output);
  }

  private async complete<T>(
    endpoint: Extract<Endpoint, { provider: "openai" }>,
    name: string,
    schema: z.ZodType<T>,
    messages: LlmMessage[],
    temperature: number,
  ): Promise<string> {
    const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema);
    const response = await fetch(`${endpoint.base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(endpoint.apiKey && { authorization: `Bearer ${endpoint.apiKey}` }) },
      body: JSON.stringify({
        model: endpoint.model,
        messages,
        temperature,
        // Sem raciocínio: no Gemma 4 local ele multiplica o tempo por 8 sem melhorar as respostas curtas.
        reasoning_effort: "none",
        response_format: { type: "json_schema", json_schema: { name, strict: true, schema: jsonSchema } },
      }),
      signal: AbortSignal.timeout(endpoint.timeoutMs),
    });
    if (!response.ok) throw new Error(`A LLM respondeu HTTP ${response.status}.`);
    const body = (await response.json()) as { choices?: { message?: { content?: string | null } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("A LLM não respondeu.");
    return content;
  }
}
