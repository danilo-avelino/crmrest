import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "@nestjs/common";
import type { DatabaseService } from "../core/database.service.js";
import { CLAUDE_PRICES } from "./llm.client.js";

/** Gravações e leituras do cache do prompt custam 1,25x e 0,1x a entrada. */
const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

/**
 * Grava o uso de uma chamada ao Claude em AiUsage (mesmo cálculo do AnthropicLlmProvider: cache somado na entrada).
 * Sem preço para o modelo o gasto fica só em tokens. Falha aqui não derruba a resposta.
 */
export async function recordClaudeUsage(db: DatabaseService, logger: Logger, tenantId: string, model: string, usage: Anthropic.Usage): Promise<void> {
  const price = CLAUDE_PRICES[model];
  if (!price) logger.warn(`Sem preço para o modelo ${model}: o gasto fica registrado só em tokens.`);
  const written = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const costMicroUsd = price ? Math.round((usage.input_tokens + written * CACHE_WRITE + read * CACHE_READ) * price.input + usage.output_tokens * price.output) : 0;
  try {
    await db.withTenants({ tenantIds: [tenantId] }, (tx) =>
      tx.aiUsage.create({
        data: { tenantId, provider: "CLAUDE", model, inputTokens: usage.input_tokens + written + read, outputTokens: usage.output_tokens, costMicroUsd },
        select: { id: true },
      }),
    );
  } catch (error) {
    logger.warn(`Uso da IA não registrado: ${error instanceof Error ? error.message : String(error)}`);
  }
}
