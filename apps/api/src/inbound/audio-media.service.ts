import { Processor } from "@nestjs/bullmq";
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { automationMessagesOf, type MessageContent } from "@dishdesk/shared";
import type { Job, Queue } from "bullmq";
import { ConnectorsService } from "../connectors/connectors.service.js";
import { DatabaseService } from "../core/database.service.js";
import { JobProcessor } from "../queues/job-processor.js";
import { type AutomationState, automationMessage, dispatch } from "../automations/automation.js";
import { ENV, type Env } from "../config/env.js";
import { type AiJob, type OutboundJob, QUEUES, type TranscriptionJob } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { StorageService } from "../storage/storage.service.js";
import { menuVocabulary, OpenRouterTranscriptionProvider, type TranscriptionProvider } from "./transcription.js";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_SECONDS = 3 * 60;
/** Tentativas e espera do job: 3 vezes, sem tempestade de reenvios. */
export const AUDIO_JOB_OPTIONS = { attempts: 3, backoff: { type: "exponential", delay: 5_000 } } as const;

/**
 * Áudio recebido de um restaurante com o módulo MENU (F5-01): baixa o arquivo da plataforma, guarda no storage privado
 * (chave em `content.media.storageKey`) e enfileira a transcrição (F5-02). Quem não tem o módulo não passa por aqui.
 */
@Injectable()
export class AudioMediaService {
  private readonly logger = new Logger(AudioMediaService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly connectors: ConnectorsService,
    private readonly storage: StorageService,
    @InjectQueue(QUEUES.transcription) private readonly queue: Queue<TranscriptionJob>,
  ) {}

  /** Um job por mensagem (o id do job é a trava contra duplicidade). */
  async enqueue(tenantId: string, messageId: string): Promise<void> {
    await this.queue.add("store-audio", { tenantId, messageId }, { jobId: `store-audio-${messageId}`, ...AUDIO_JOB_OPTIONS });
  }

  async store(tenantId: string, messageId: string): Promise<void> {
    const scope = { tenantIds: [tenantId] };
    const message = await this.db.withTenants(scope, (tx) =>
      tx.message.findUnique({ where: { id: messageId }, select: { content: true, channel: { select: { type: true, credentials: true } } } }),
    );
    const content = message?.content as MessageContent | undefined;
    const media = content?.media;
    if (!message || !media || media.storageKey || media.storeError) return;
    const mark = (patch: Partial<NonNullable<MessageContent["media"]>>) =>
      this.db.withTenants(scope, (tx) =>
        tx.message.update({ where: { id: messageId }, data: { content: { ...content, media: { ...media, ...patch } } as object } }),
      );
    if (media.seconds !== undefined && media.seconds > MAX_SECONDS) {
      this.logger.warn(`Áudio ${messageId} acima de 3 minutos: não guardado`);
      return void (await mark({ storeError: "too_long" }));
    }
    const { accessToken, instance } = this.connectors.secrets(message.channel.credentials);
    if (message.channel.type !== "WHATSAPP" || !media.externalMediaId) return void (await mark({ storeError: "no_source" }));
    const file = instance
      ? await this.connectors.evolution.fetchMedia(instance, accessToken, media.externalMediaId)
      : await this.connectors.whatsapp.fetchMedia(media.externalMediaId, accessToken);
    if (!file.ok) throw new Error(`HTTP ${file.status}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) {
      this.logger.warn(`Áudio ${messageId} acima de 16 MB: não guardado`);
      return void (await mark({ storeError: "too_large" }));
    }
    const mime = media.mimeType.includes("*") ? (file.headers.get("content-type") ?? media.mimeType) : media.mimeType;
    const { key } = await this.storage.put(tenantId, "audio", bytes, mime);
    await mark({ storageKey: key });
    await this.queue.add("transcribe", { tenantId, messageId }, { jobId: `transcribe-${messageId}`, ...AUDIO_JOB_OPTIONS });
  }

  /** Falha definitiva (3 tentativas): fica marcada na mensagem, sem novo envio. */
  async markFailed(tenantId: string, messageId: string, reason: string): Promise<void> {
    this.logger.warn(`Áudio ${messageId} não guardado: ${reason}`);
    const scope = { tenantIds: [tenantId] };
    await this.db.withTenants(scope, async (tx) => {
      const message = await tx.message.findUnique({ where: { id: messageId }, select: { content: true } });
      const content = message?.content as MessageContent | undefined;
      if (!content?.media) return;
      await tx.message.update({ where: { id: messageId }, data: { content: { ...content, media: { ...content.media, storeError: "failed" } } as object } });
    });
  }
}

/** Preço do Whisper large-v3-turbo no OpenRouter: US$ 0,000003 por segundo (22/11/2026). Em `inputTokens` vão os segundos. */
export const TRANSCRIPTION_MICRO_USD_PER_SECOND = 3;

/** Transcrição guardada que é texto do cliente (e não um estado: pendente, sem provedor ou falha). */
export const isTranscribedText = (value: string | undefined): value is string =>
  Boolean(value) && value !== "pending" && value !== "pending_provider" && value !== "failed";

/**
 * Worker da fila transcription: guarda o áudio (store-audio) e o transcreve (transcribe, F5-02) com o vocabulário do
 * cardápio. Sem a chave do provedor, a transcrição fica "pending_provider". Depois, se a IA atende a conversa, ela
 * responde ao áudio já como texto (F5-03); sem entender o áudio, sai o `menuAudioFailed` no tom do restaurante.
 */
@Processor(QUEUES.transcription)
export class TranscriptionProcessor extends JobProcessor {
  private readonly logger = new Logger(TranscriptionProcessor.name);
  /** Provedor (Whisper pelo OpenRouter); os testes trocam por um falso. */
  provider: TranscriptionProvider;
  private readonly model: string;

  constructor(
    private readonly audio: AudioMediaService,
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
    @InjectQueue(QUEUES.ai) private readonly ai: Queue<AiJob>,
    @Inject(ENV) env: Env,
  ) {
    super();
    this.provider = new OpenRouterTranscriptionProvider(env);
    this.model = env.TRANSCRIPTION_MODEL;
  }

  async process(job: Job<TranscriptionJob>): Promise<void> {
    const { tenantId, messageId } = job.data;
    if (job.name === "store-audio") {
      try {
        await this.audio.store(tenantId, messageId);
      } catch (error) {
        const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if (last) await this.audio.markFailed(tenantId, messageId, error instanceof Error ? error.message : String(error));
        throw error;
      }
      return;
    }
    try {
      await this.transcribe(tenantId, messageId);
    } catch (error) {
      const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      this.logger.warn(`Transcrição da mensagem ${messageId} falhou: ${error instanceof Error ? error.message : String(error)}`);
      if (!last) throw error;
      await this.finish(tenantId, messageId, "failed");
    }
  }

  async transcribe(tenantId: string, messageId: string): Promise<void> {
    const scope = { tenantIds: [tenantId] };
    const loaded = await this.db.withTenants(scope, async (tx) => {
      const message = await tx.message.findUnique({ where: { id: messageId }, select: { content: true } });
      const content = message?.content as MessageContent | undefined;
      const media = content?.media;
      if (!media?.storageKey || isTranscribedText(media.transcription) || media.transcription === "failed") return null;
      const menu = await tx.menu.findUnique({ where: { tenantId }, select: { id: true } });
      const items = menu ? await tx.menuItem.findMany({ where: { tenantId, active: true }, select: { name: true }, orderBy: { sortOrder: "asc" }, take: 150 }) : [];
      const categories = menu ? await tx.menuCategory.findMany({ where: { tenantId, menuId: menu.id }, select: { name: true }, take: 30 }) : [];
      return { media, vocabulary: menuVocabulary([...categories.map((c) => c.name), ...items.map((i) => i.name)]) };
    });
    if (!loaded) return;
    if (!this.provider.configured) {
      this.logger.log(`Transcrição da mensagem ${messageId} pendente de provedor`);
      await this.patch(tenantId, messageId, "pending_provider");
      return;
    }
    await this.patch(tenantId, messageId, "pending");
    const bytes = await this.storage.get(tenantId, loaded.media.storageKey!);
    const { text, seconds } = await this.provider.transcribe({ bytes, mimeType: loaded.media.mimeType, vocabulary: loaded.vocabulary });
    // Custo em Gastos com IA: por segundo de áudio (o do provedor, senão a duração da mensagem).
    const billed = Math.max(1, Math.ceil(seconds ?? loaded.media.seconds ?? 0));
    await this.db.withTenants(scope, (tx) =>
      tx.aiUsage.create({
        data: { tenantId, provider: "TRANSCRIPTION", model: this.model, inputTokens: billed, outputTokens: 0, costMicroUsd: billed * TRANSCRIPTION_MICRO_USD_PER_SECOND },
      }),
    );
    await this.finish(tenantId, messageId, text ? text.slice(0, 2_000) : "failed");
  }

  private patch(tenantId: string, messageId: string, transcription: string) {
    return this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const message = await tx.message.findUnique({ where: { id: messageId }, select: { content: true, conversationId: true } });
      const content = message?.content as MessageContent | undefined;
      if (!message || !content?.media) return null;
      await tx.message.update({ where: { id: messageId }, data: { content: { ...content, media: { ...content.media, transcription } } as object } });
      return message.conversationId;
    });
  }

  /** Grava o texto (ou a falha) e, com a IA atendendo, faz ela responder: ao texto, ou pedindo para repetir. */
  private async finish(tenantId: string, messageId: string, transcription: string): Promise<void> {
    const conversationId = await this.patch(tenantId, messageId, transcription);
    if (!conversationId) return;
    this.realtime.inboxChanged(tenantId, conversationId);
    const next = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const conversation = await tx.conversation.findUnique({
        where: { id: conversationId },
        select: { id: true, tenantId: true, channelId: true, automationState: true, tenant: { select: { settings: true } } },
      });
      if (!conversation || (conversation.automationState as AutomationState | null)?.ai !== "on") return null;
      // Só o último INBOUND conta: se o cliente já mandou outra coisa, o job dela responde.
      const latest = await tx.message.findFirst({ where: { conversationId, direction: { in: ["INBOUND", "OUTBOUND"] } }, orderBy: { createdAt: "desc" }, select: { id: true } });
      if (latest?.id !== messageId) return null;
      if (transcription !== "failed") return { reply: true as const };
      return { ids: [await automationMessage(tx, conversation, "menu_audio_failed", automationMessagesOf(conversation.tenant.settings).menuAudioFailed)] };
    });
    if (!next) return;
    if ("reply" in next) await this.ai.add("reply", { tenantId, conversationId });
    else await dispatch(this.outbound, this.realtime, tenantId, conversationId, next.ids);
  }
}
