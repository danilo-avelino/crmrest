import type { TenantTx } from "@dishdesk/database";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { ENV, type Env } from "../config/env.js";

export type LlmMessage = { role: "system" | "user"; content: string };

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

  async json<T>(name: string, schema: z.ZodType<T>, messages: LlmMessage[]): Promise<T> {
    if (!this.env.AI_BASE_URL) throw new Error("IA desligada: falta AI_BASE_URL.");
    const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema);
    const response = await fetch(`${this.env.AI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.env.AI_API_KEY && { authorization: `Bearer ${this.env.AI_API_KEY}` }) },
      body: JSON.stringify({
        model: this.env.AI_MODEL,
        messages,
        temperature: 0.3,
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
    return schema.parse(JSON.parse(content));
  }
}
