import type { TenantTx } from "@dishdesk/database";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { ENV, type Env } from "../config/env.js";

export type LlmMessage = { role: "system" | "user"; content: string };

/** Respostas fora do formato (JSON inválido ou fora do schema) antes de desistir. */
const PARSE_ATTEMPTS = 2;

type Endpoint = { base: string; apiKey?: string; model: string; timeoutMs: number };

/**
 * LLM do módulo Atendimento com IA (AI_BASE_URL), no formato da OpenAI: o Ollama local ou um provedor. A resposta vem
 * em JSON no formato do schema e é validada por ele. Com a principal fora do ar, a chamada vai para a reserva
 * (AI_FALLBACK_BASE_URL), se houver.
 */
@Injectable()
export class LlmClient {
  private readonly logger = new Logger(LlmClient.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** O restaurante tem o módulo Atendimento com IA e a API tem uma LLM configurada. */
  async activeFor(tx: TenantTx, tenantId: string): Promise<boolean> {
    if (!this.env.AI_BASE_URL) return false;
    const module = await tx.tenantModule.findUnique({ where: { tenantId_module: { tenantId, module: "AI" } }, select: { id: true } });
    return !!module;
  }

  async json<T>(name: string, schema: z.ZodType<T>, messages: LlmMessage[], temperature = 0.3): Promise<T> {
    return (await this.answer(name, schema, messages, temperature)).result;
  }

  /** Como json, dizendo também qual modelo respondeu (o da principal ou o da reserva). */
  async answer<T>(name: string, schema: z.ZodType<T>, messages: LlmMessage[], temperature = 0.3): Promise<{ result: T; model: string }> {
    const main = this.env.AI_BASE_URL;
    if (!main) throw new Error("IA desligada: falta AI_BASE_URL.");
    const endpoints: Endpoint[] = [{ base: main, apiKey: this.env.AI_API_KEY, model: this.env.AI_MODEL, timeoutMs: this.env.AI_TIMEOUT_MS }];
    if (this.env.AI_FALLBACK_BASE_URL) {
      endpoints.push({
        base: this.env.AI_FALLBACK_BASE_URL,
        apiKey: this.env.AI_FALLBACK_API_KEY,
        model: this.env.AI_FALLBACK_MODEL ?? this.env.AI_MODEL,
        timeoutMs: this.env.AI_FALLBACK_TIMEOUT_MS,
      });
    }
    const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema);
    // O modelo local às vezes devolve um JSON quebrado (vírgula sobrando, texto cortado): pede de novo antes de desistir.
    for (let attempt = 1; ; attempt++) {
      const { content, model } = await this.completeAny(endpoints, name, jsonSchema, messages, temperature);
      try {
        return { result: schema.parse(JSON.parse(content)), model };
      } catch (error) {
        if (attempt >= PARSE_ATTEMPTS) throw error;
      }
    }
  }

  /** A principal; se ela não responder (rede, prazo ou erro HTTP), a reserva. */
  private async completeAny(
    endpoints: Endpoint[],
    name: string,
    jsonSchema: Record<string, unknown>,
    messages: LlmMessage[],
    temperature: number,
  ): Promise<{ content: string; model: string }> {
    for (const [index, endpoint] of endpoints.entries()) {
      try {
        return { content: await this.complete(endpoint, name, jsonSchema, messages, temperature), model: endpoint.model };
      } catch (error) {
        if (index === endpoints.length - 1) throw error;
        this.logger.warn(`LLM principal sem resposta (${error instanceof Error ? error.message : String(error)}): usando a reserva`);
      }
    }
    throw new Error("A LLM não respondeu.");
  }

  private async complete(endpoint: Endpoint, name: string, jsonSchema: Record<string, unknown>, messages: LlmMessage[], temperature: number): Promise<string> {
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
