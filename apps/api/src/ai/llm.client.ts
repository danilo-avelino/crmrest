import type { TenantTx } from "@dishdesk/database";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { ENV, type Env } from "../config/env.js";

export type LlmMessage = { role: "system" | "user"; content: string };

/** Respostas fora do formato (JSON inválido ou fora do schema) antes de desistir. */
const PARSE_ATTEMPTS = 2;

/**
 * LLM do módulo Atendimento com IA (AI_BASE_URL), no formato da OpenAI: o Ollama local ou um provedor. A resposta vem
 * em JSON no formato do schema e é validada por ele.
 */
@Injectable()
export class LlmClient {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get model(): string {
    return this.env.AI_MODEL;
  }

  /** O restaurante tem o módulo Atendimento com IA e a API tem uma LLM configurada. */
  async activeFor(tx: TenantTx, tenantId: string): Promise<boolean> {
    if (!this.env.AI_BASE_URL) return false;
    const module = await tx.tenantModule.findUnique({ where: { tenantId_module: { tenantId, module: "AI" } }, select: { id: true } });
    return !!module;
  }

  async json<T>(name: string, schema: z.ZodType<T>, messages: LlmMessage[], temperature = 0.3): Promise<T> {
    const base = this.env.AI_BASE_URL;
    if (!base) throw new Error("IA desligada: falta AI_BASE_URL.");
    const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema);
    // O modelo local às vezes devolve um JSON quebrado (vírgula sobrando, texto cortado): pede de novo antes de desistir.
    for (let attempt = 1; ; attempt++) {
      const content = await this.complete(base, name, jsonSchema, messages, temperature);
      try {
        return schema.parse(JSON.parse(content));
      } catch (error) {
        if (attempt >= PARSE_ATTEMPTS) throw error;
      }
    }
  }

  private async complete(base: string, name: string, jsonSchema: Record<string, unknown>, messages: LlmMessage[], temperature: number): Promise<string> {
    const response = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.env.AI_API_KEY && { authorization: `Bearer ${this.env.AI_API_KEY}` }) },
      body: JSON.stringify({
        model: this.env.AI_MODEL,
        messages,
        temperature,
        // Sem raciocínio: no Gemma 4 local ele multiplica o tempo por 8 sem melhorar as respostas curtas.
        reasoning_effort: "none",
        response_format: { type: "json_schema", json_schema: { name, strict: true, schema: jsonSchema } },
      }),
      signal: AbortSignal.timeout(this.env.AI_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`A LLM respondeu HTTP ${response.status}.`);
    const body = (await response.json()) as { choices?: { message?: { content?: string | null } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("A LLM não respondeu.");
    return content;
  }
}
