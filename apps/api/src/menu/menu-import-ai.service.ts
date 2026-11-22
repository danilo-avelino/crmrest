import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { InjectQueue, Processor } from "@nestjs/bullmq";
import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, type OnModuleDestroy, Optional } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { Redis } from "ioredis";
import { CLAUDE_PRICES } from "../ai/llm.client.js";
import type { MessagesApi } from "../ai/llm-provider.js";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { JobProcessor } from "../queues/job-processor.js";
import { type MenuImportAiJob, QUEUES } from "../queues/queues.module.js";
import { adminScope } from "../settings/tenant-admin.js";
import { StorageService } from "../storage/storage.service.js";
import { planImport } from "./menu-import.js";
import { existingNames, ImportCommitRequest } from "./menu-import.service.js";
import {
  AI_IMPORT_DAILY_LIMIT,
  AI_IMPORT_MODEL,
  AI_IMPORT_PROMPT,
  AI_IMPORT_SYSTEM,
  type AiImportMime,
  type AiImportRow,
  AiExtraction,
  aiFileProblem,
  pdfPageCount,
  toImportRows,
} from "./menu-import-ai.js";
import { requireModule } from "./menu.service.js";

/** Token opcional do SDK de mensagens (o teste troca por um mock). */
export const MENU_AI_MESSAGES = "MENU_AI_MESSAGES";

const UNREADABLE = "Não conseguimos ler o arquivo. A foto pode estar escura ou cortada. Envie uma foto mais nítida, um PDF ou use o CSV.";

/** O que o job devolve ao terminar (fica no Redis até a revisão); `problem`: a IA não conseguiu ler (vai para a tela). */
export type MenuImportAiResult = { rows: AiImportRow[]; problem?: string };

/** Arquivo que a IA não conseguiu ler: não adianta tentar de novo; a mensagem vai para a tela. */
export class MenuReadError extends Error {}

/**
 * Lê a foto ou o PDF com o Claude (structured outputs) e devolve as linhas no formato do CSV. Uma resposta fora do
 * formato tenta de novo uma vez. Cada chamada grava o uso em AiUsage, como o AnthropicLlmProvider.
 */
@Injectable()
export class MenuImportAiExtractor {
  private readonly logger = new Logger(MenuImportAiExtractor.name);
  private readonly messagesApi: MessagesApi | null;

  constructor(
    @Inject(ENV) env: Env,
    private readonly db: DatabaseService,
    @Optional() @Inject(MENU_AI_MESSAGES) messagesApi?: MessagesApi,
  ) {
    const key = env.AI_FALLBACK_PROVIDER === "anthropic" ? env.AI_FALLBACK_API_KEY : undefined;
    this.messagesApi = messagesApi ?? (key ? new Anthropic({ apiKey: key, baseURL: env.AI_FALLBACK_BASE_URL }).messages : null);
  }

  get enabled(): boolean {
    return !!this.messagesApi;
  }

  async extract(tenantId: string, bytes: Uint8Array, mime: AiImportMime): Promise<AiImportRow[]> {
    if (!this.messagesApi) throw new MenuReadError("A leitura por IA não está disponível agora. Use o CSV.");
    const data = Buffer.from(bytes).toString("base64");
    const file: Anthropic.ContentBlockParam =
      mime === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
        : { type: "image", source: { type: "base64", media_type: mime, data } };
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await this.messagesApi.create(
        {
          model: AI_IMPORT_MODEL,
          max_tokens: 32_000,
          system: AI_IMPORT_SYSTEM,
          messages: [{ role: "user", content: [file, { type: "text", text: AI_IMPORT_PROMPT }] }],
          output_config: { effort: "medium", format: zodOutputFormat(AiExtraction) },
        },
        { timeout: 600_000 },
      );
      await this.recordUsage(tenantId, response.usage);
      if (response.stop_reason === "refusal") throw new MenuReadError(UNREADABLE);
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      const parsed = parseExtraction(text);
      if (!parsed) {
        this.logger.warn(`Leitura do cardápio fora do formato (tentativa ${attempt}, stop ${response.stop_reason}).`);
        continue;
      }
      if (!parsed.readable || parsed.items.length === 0) throw new MenuReadError(parsed.problem?.trim() ? `${parsed.problem.trim()} ${UNREADABLE}` : UNREADABLE);
      return toImportRows(parsed);
    }
    throw new MenuReadError("A IA não devolveu os itens num formato válido. Tente de novo ou use o CSV.");
  }

  private async recordUsage(tenantId: string, usage: Anthropic.Usage): Promise<void> {
    const price = CLAUDE_PRICES[AI_IMPORT_MODEL];
    const written = usage.cache_creation_input_tokens ?? 0;
    const read = usage.cache_read_input_tokens ?? 0;
    const costMicroUsd = price ? Math.round((usage.input_tokens + written * 1.25 + read * 0.1) * price.input + usage.output_tokens * price.output) : 0;
    try {
      await this.db.withTenants({ tenantIds: [tenantId] }, (tx) =>
        tx.aiUsage.create({
          data: { tenantId, provider: "CLAUDE", model: AI_IMPORT_MODEL, inputTokens: usage.input_tokens + written + read, outputTokens: usage.output_tokens, costMicroUsd },
          select: { id: true },
        }),
      );
    } catch (error) {
      this.logger.warn(`Uso da IA não registrado: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function parseExtraction(text: string): AiExtraction | null {
  try {
    const result = AiExtraction.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

const dayKey = (tenantId: string) => `ratelimit:menu-import-ai:${tenantId}:${new Date().toISOString().slice(0, 10)}`;

export type MenuImportAiStatus =
  | { status: "reading"; progress: number; fileName: string; pages: number | null }
  | { status: "failed"; message: string; fileName: string }
  | ({ status: "done"; fileName: string; pages: number | null; mime: string; fileUrl: string | null } & ReturnType<typeof planImport>);

/**
 * Importação por foto/PDF (F2-10) no painel: grava o arquivo no bucket privado, enfileira a leitura (fila menu) e mostra
 * o resultado. Nada é gravado no cardápio aqui: a revisão termina no commit do CSV, que valida tudo de novo.
 */
@Injectable()
export class MenuImportAiService implements OnModuleDestroy {
  /** Contador diário por restaurante (o limite vale em todas as réplicas da API). */
  private readonly redis: Redis;

  constructor(
    @Inject(ENV) env: Env,
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    @InjectQueue(QUEUES.menu) private readonly queue: Queue<MenuImportAiJob, MenuImportAiResult>,
  ) {
    this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  /** Só o administrador, com o módulo MENU (antes de ler o corpo). */
  assertAllowed(auth: RequestAuth, tenantId: string) {
    return this.db.withTenants(adminScope(auth, tenantId), (tx) => requireModule(tx, tenantId));
  }

  async start(auth: RequestAuth, tenantId: string, bytes: Uint8Array, mime: string, fileName: string): Promise<{ jobId: string }> {
    await this.assertAllowed(auth, tenantId);
    const type = mime.split(";")[0]!.trim().toLowerCase();
    const problem = aiFileProblem(type, bytes);
    if (problem) throw new BadRequestException(problem);

    const key = dayKey(tenantId);
    const used = await this.redis.incr(key);
    await this.redis.expire(key, 26 * 3600);
    if (used > AI_IMPORT_DAILY_LIMIT) {
      await this.redis.decr(key);
      throw new HttpException(`Limite de ${AI_IMPORT_DAILY_LIMIT} leituras por dia atingido. Tente amanhã ou use o CSV.`, HttpStatus.TOO_MANY_REQUESTS);
    }
    try {
      const { key: fileKey } = await this.storage.put(tenantId, "import", bytes, type);
      const jobId = randomUUID();
      const pages = type === "application/pdf" ? pdfPageCount(bytes) || null : 1;
      await this.queue.add(
        "menu-import-ai",
        { tenantId, key: fileKey, mime: type as AiImportMime, fileName: fileName.slice(0, 200), pages },
        { jobId, attempts: 2, removeOnComplete: { age: 2 * 86_400 }, removeOnFail: { age: 2 * 86_400 } },
      );
      return { jobId };
    } catch (error) {
      await this.redis.decr(key);
      throw error;
    }
  }

  async status(auth: RequestAuth, tenantId: string, jobId: string): Promise<MenuImportAiStatus> {
    await this.assertAllowed(auth, tenantId);
    const job = await this.queue.getJob(jobId);
    if (!job || job.data.tenantId !== tenantId) throw new NotFoundException("Leitura não encontrada.");
    const { fileName, pages } = job.data;
    const state = await job.getState();
    if (state === "failed" && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      return { status: "failed", message: "A leitura falhou. Tente de novo em alguns minutos ou use o CSV.", fileName };
    }
    if (state === "completed" && job.returnvalue?.problem) return { status: "failed", message: job.returnvalue.problem, fileName };
    if (state !== "completed" || !job.returnvalue) return { status: "reading", progress: typeof job.progress === "number" ? job.progress : 0, fileName, pages };
    const preview = await this.db.withTenants(adminScope(auth, tenantId), async (tx) => planImport(job.returnvalue.rows, await existingNames(tx, tenantId)));
    const fileUrl = await this.storage.signedUrl(job.data.key, 3_600).catch(() => null);
    return { status: "done", fileName, pages, mime: job.data.mime, fileUrl, ...preview };
  }

  /** Revalida as linhas editadas na revisão (mesmas regras do commit), sem gravar. */
  check(auth: RequestAuth, tenantId: string, body: ImportCommitRequest) {
    return this.db.withTenants(adminScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      return planImport(
        body.rows.map((row) => ({ ...row, errors: [] })),
        await existingNames(tx, tenantId),
      );
    });
  }
}

/** Worker da fila menu: baixa o arquivo do restaurante e lê com a IA. */
@Processor(QUEUES.menu)
export class MenuImportAiProcessor extends JobProcessor {
  constructor(
    private readonly extractor: MenuImportAiExtractor,
    private readonly storage: StorageService,
  ) {
    super();
  }

  async process(job: Job<MenuImportAiJob>): Promise<MenuImportAiResult> {
    await job.updateProgress(10);
    const bytes = await this.storage.get(job.data.tenantId, job.data.key);
    await job.updateProgress(30);
    try {
      return { rows: await this.extractor.extract(job.data.tenantId, bytes, job.data.mime) };
    } catch (error) {
      if (error instanceof MenuReadError) return { rows: [], problem: error.message };
      throw error;
    }
  }
}
