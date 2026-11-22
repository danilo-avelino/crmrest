import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { HttpException, HttpStatus, Inject, Injectable, Logger, type OnModuleDestroy, Optional, ServiceUnavailableException } from "@nestjs/common";
import { Redis } from "ioredis";
import { recordClaudeUsage } from "../ai/claude-usage.js";
import type { MessagesApi } from "../ai/llm-provider.js";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { adminScope } from "../settings/tenant-admin.js";
import { AI_FIELDS_SYSTEM, AiFieldsOutput, type AiFieldsRequest, type AiFieldsResult, aiFieldsPrompt, type MenuChoice, sanitizeAiFields } from "./menu-ai-fields.js";
import { cleanSuggestion, DESCRIBE_DAILY_LIMIT, DESCRIBE_MODEL, DESCRIBE_SYSTEM, type DescribeRequest, describePrompt } from "./menu-describe.js";
import { MENU_AI_MESSAGES } from "./menu-import-ai.service.js";
import { requireModule } from "./menu.service.js";

const NOT_CONFIGURED = "A IA não está configurada neste ambiente.";
const FAILED = "Não foi possível gerar a sugestão agora. Tente de novo em instantes.";
/** Itens do cardápio mostrados ao modelo para o "combina com". */
const MAX_CHOICES = 300;

const dayKey = (tenantId: string) => `ratelimit:menu-describe:${tenantId}:${new Date().toISOString().slice(0, 10)}`;

/**
 * Sugestões do item com o Claude Haiku 5.5 (F2-15): a descrição ("Melhorar com IA") e os campos da aba "Para a IA"
 * ("Preencher com IA"). A chave é a dos outros usos (AI_FALLBACK_API_KEY com AI_FALLBACK_PROVIDER=anthropic). Nada é
 * gravado no item: a sugestão volta para o painel, que o administrador aceita, edita ou descarta. Cada chamada grava o
 * uso em AiUsage e as duas contam no mesmo limite diário do restaurante (Redis).
 */
@Injectable()
export class MenuDescribeService implements OnModuleDestroy {
  private readonly logger = new Logger(MenuDescribeService.name);
  private readonly messagesApi: MessagesApi | null;
  private readonly redis: Redis;

  constructor(
    @Inject(ENV) env: Env,
    private readonly db: DatabaseService,
    @Optional() @Inject(MENU_AI_MESSAGES) messagesApi?: MessagesApi,
  ) {
    const key = env.AI_FALLBACK_PROVIDER === "anthropic" ? env.AI_FALLBACK_API_KEY : undefined;
    this.messagesApi = messagesApi ?? (key ? new Anthropic({ apiKey: key, baseURL: env.AI_FALLBACK_BASE_URL }).messages : null);
    this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  async describe(auth: RequestAuth, tenantId: string, body: DescribeRequest): Promise<{ suggestion: string }> {
    await this.assertAllowed(auth, tenantId);
    const suggestion = await this.generate(tenantId, async (api) => {
      const text = await this.ask(api, tenantId, DESCRIBE_SYSTEM, describePrompt(body), 600, undefined);
      return text === null ? null : cleanSuggestion(text);
    });
    return { suggestion };
  }

  /** Os campos da aba "Para a IA". A lista de itens para o "combina com" vem do banco, nunca do cliente. */
  async aiFields(auth: RequestAuth, tenantId: string, body: AiFieldsRequest): Promise<AiFieldsResult> {
    await this.assertAllowed(auth, tenantId);
    const rows = await this.db.withTenants(adminScope(auth, tenantId), (tx) =>
      tx.menuItem.findMany({
        where: { tenantId, active: true, ...(body.itemId && { id: { not: body.itemId } }) },
        select: { id: true, name: true, category: { select: { name: true } } },
        orderBy: { name: "asc" },
        take: MAX_CHOICES,
      }),
    );
    const others: MenuChoice[] = rows.map((row) => ({ id: row.id, name: row.name, categoryName: row.category.name }));
    const validIds = new Set(others.map((item) => item.id));
    return this.generate(tenantId, async (api) => {
      const text = await this.ask(api, tenantId, AI_FIELDS_SYSTEM, aiFieldsPrompt(body, others), 1_500, zodOutputFormat(AiFieldsOutput));
      if (text === null) return null;
      try {
        const parsed = AiFieldsOutput.safeParse(JSON.parse(text));
        return parsed.success ? sanitizeAiFields(parsed.data, validIds) : null;
      } catch {
        return null;
      }
    });
  }

  /** Só o administrador, com o módulo MENU. */
  private assertAllowed(auth: RequestAuth, tenantId: string) {
    return this.db.withTenants(adminScope(auth, tenantId), (tx) => requireModule(tx, tenantId));
  }

  /** Uma chamada ao modelo com o uso gravado; `null` quando a resposta é recusa ou sem texto. */
  private async ask(api: MessagesApi, tenantId: string, system: string, prompt: string, maxTokens: number, format: ReturnType<typeof zodOutputFormat> | undefined) {
    const response = await api.create(
      { model: DESCRIBE_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }], ...(format && { output_config: { format } }) },
      { timeout: 60_000 },
    );
    await recordClaudeUsage(this.db, this.logger, tenantId, DESCRIBE_MODEL, response.usage);
    if (response.stop_reason === "refusal") return null;
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  /** 503 sem chave, 429 acima do limite do dia; uma segunda tentativa se a resposta não servir; 502 se falhar. */
  private async generate<T>(tenantId: string, attempt: (api: MessagesApi) => Promise<T | null>): Promise<T> {
    const api = this.messagesApi;
    if (!api) throw new ServiceUnavailableException(NOT_CONFIGURED);
    const key = dayKey(tenantId);
    const used = await this.redis.incr(key);
    await this.redis.expire(key, 26 * 3600);
    if (used > DESCRIBE_DAILY_LIMIT) {
      await this.redis.decr(key);
      throw new HttpException(`Limite de ${DESCRIBE_DAILY_LIMIT} sugestões por dia atingido. Tente amanhã.`, HttpStatus.TOO_MANY_REQUESTS);
    }
    try {
      for (let tries = 1; tries <= 2; tries++) {
        const result = await attempt(api);
        if (result !== null) return result;
        this.logger.warn(`Sugestão do item inválida (tentativa ${tries}).`);
      }
    } catch (error) {
      this.logger.warn(`Sugestão do item falhou: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.redis.decr(key);
    throw new HttpException(FAILED, HttpStatus.BAD_GATEWAY);
  }
}
