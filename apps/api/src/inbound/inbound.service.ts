import { blindIndex, type Contact, encrypt, parseEncryptionKey, type Prisma, type TenantTx } from "@comanda/database";
import type { ChannelType, ConversationStatus, MessageStatus } from "@comanda/database/enums";
import { CHANNEL_CAPABILITIES, CHANNEL_LABEL, type MessageContent, type NormalizedMessage, type StatusUpdate } from "@comanda/shared";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { TriageService } from "../automations/triage.service.js";
import { ENV, type Env } from "../config/env.js";
import { ConnectorsService } from "../connectors/connectors.service.js";
import { parseInstagram } from "../connectors/instagram.connector.js";
import { splitMetaPayload } from "../connectors/meta.js";
import { parseWhatsApp } from "../connectors/whatsapp.connector.js";
import { DatabaseService } from "../core/database.service.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";

export type ResolvedChannel = { id: string; tenantId: string; type: ChannelType };

/** O que a resolução de identidade precisa saber de quem chegou (mensagem ou pedido). */
export type ContactSource = Pick<NormalizedMessage, "channelType" | "externalContactId" | "contactProfile" | "metadata" | "timestamp">;

/** Conversa que recebeu a mensagem e o status que ela tinha antes (null = conversa nova). */
export type OpenedConversation = { id: string; previousStatus: ConversationStatus | null };

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Um status só avança (ex.: READ não volta para DELIVERED se os webhooks chegarem fora de ordem).
const PREVIOUS_STATUSES: Record<StatusUpdate["status"], MessageStatus[]> = {
  SENT: ["PENDING"],
  DELIVERED: ["PENDING", "SENT"],
  READ: ["PENDING", "SENT", "DELIVERED"],
  FAILED: ["PENDING", "SENT"],
};

/** Worker inbound (§3.5): do webhook bruto até a mensagem na conversa certa. */
@Injectable()
export class InboundService {
  private readonly logger = new Logger(InboundService.name);
  private readonly key: Buffer;

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    private readonly connectors: ConnectorsService,
    private readonly triage: TriageService,
    @Inject(ENV) env: Env,
  ) {
    this.key = parseEncryptionKey(env.ENCRYPTION_KEY);
  }

  async processMeta(payload: unknown): Promise<void> {
    for (const batch of splitMetaPayload(payload)) {
      const channel = await this.resolveChannel(batch.channelType, batch.externalId);
      if (!channel) {
        this.logger.warn(`Webhook de canal desconhecido: ${batch.channelType} ${batch.externalId}`);
        continue;
      }
      const parsed =
        batch.channelType === "WHATSAPP" ? parseWhatsApp(channel.id, batch.value) : parseInstagram(channel.id, batch.events);
      if (parsed.rejected) this.logger.warn(`${parsed.rejected} evento(s) fora do formato esperado ignorado(s)`);
      for (const message of parsed.messages) {
        const conversation = await this.handleMessage(channel, await this.withProfile(channel, message));
        // "SAIR" pede para parar de receber mensagens: não é hora de responder com o menu.
        if (conversation && !(channel.type === "WHATSAPP" && isOptOut(message.text))) {
          await this.triage.afterInbound({
            channel,
            conversationId: conversation.id,
            previousStatus: conversation.previousStatus,
            text: message.text,
          });
        }
      }
      for (const status of parsed.statuses) await this.handleStatus(channel, status);
    }
  }

  /** Webhooks chegam sem contexto: o canal é achado por uma função restrita do banco. */
  private async resolveChannel(type: ChannelType, externalId: string): Promise<ResolvedChannel | null> {
    const [row] = await this.db.client.$queryRaw<{ id: string; tenant_id: string }[]>`
      SELECT id, tenant_id FROM app.resolve_channel(${type}::"ChannelType", ${externalId})`;
    return row ? { id: row.id, tenantId: row.tenant_id, type } : null;
  }

  /** O webhook do Instagram só traz o id de quem escreveu: no primeiro contato, busca nome e @. */
  private async withProfile(channel: ResolvedChannel, message: NormalizedMessage): Promise<NormalizedMessage> {
    if (channel.type !== "INSTAGRAM") return message;
    const scope = { tenantIds: [channel.tenantId] };
    const { known, credentials } = await this.db.withTenants(scope, async (tx) => ({
      known: await tx.contactIdentity.findUnique({
        where: {
          tenantId_channelType_externalId: { tenantId: channel.tenantId, channelType: "INSTAGRAM", externalId: message.externalContactId },
        },
        select: { id: true },
      }),
      credentials: (await tx.channel.findUniqueOrThrow({ where: { id: channel.id }, select: { credentials: true } })).credentials,
    }));
    if (known) return message;
    try {
      const { accessToken } = this.connectors.secrets(credentials);
      const profile = await this.connectors.instagram.fetchProfile(message.externalContactId, accessToken);
      return {
        ...message,
        contactProfile: { ...message.contactProfile, name: profile.name ?? profile.username },
        metadata: { ...message.metadata, ...(profile.username && { username: profile.username }) },
      };
    } catch (error) {
      this.logger.warn(`Perfil do Instagram indisponível: ${error instanceof Error ? error.message : String(error)}`);
      return message;
    }
  }

  /** Grava a mensagem recebida; devolve a conversa, ou null se o webhook era repetido. */
  async handleMessage(channel: ResolvedChannel, message: NormalizedMessage): Promise<OpenedConversation | null> {
    const at = arrivalTime(message.timestamp);
    const opened = await this.db.withTenants({ tenantIds: [channel.tenantId] }, async (tx) => {
      const duplicate = await tx.message.findUnique({
        where: { channelId_externalMessageId: { channelId: channel.id, externalMessageId: message.externalMessageId } },
        select: { id: true },
      });
      if (duplicate) return null; // webhook reenviado pela plataforma

      const contact = await this.resolveContact(tx, channel.tenantId, message);
      const conversation = await this.openConversation(tx, channel, contact.id, at);
      await tx.message.create({
        data: {
          tenantId: channel.tenantId,
          conversationId: conversation.id,
          channelId: channel.id,
          externalMessageId: message.externalMessageId,
          direction: "INBOUND",
          type: message.type,
          content: contentOf(message),
          status: "DELIVERED",
          createdAt: at,
        },
      });
      if (channel.type === "WHATSAPP" && isOptOut(message.text)) {
        // Opt-out (§5.5): registrado já no MVP, para as campanhas respeitarem quando existirem.
        await tx.consent.create({
          data: { tenantId: channel.tenantId, contactId: contact.id, purpose: "marketing_whatsapp", granted: false, source: "whatsapp_keyword" },
        });
        await tx.message.create({
          data: {
            tenantId: channel.tenantId,
            conversationId: conversation.id,
            channelId: channel.id,
            direction: "INTERNAL",
            type: "SYSTEM",
            content: { event: "opt_out", text: "Cliente pediu para não receber campanhas" },
            createdAt: new Date(at.getTime() + 1),
          },
        });
      }
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          status: "OPEN",
          lastMessageAt: at,
          unreadCount: { increment: 1 },
          ...(CHANNEL_CAPABILITIES[channel.type].window24h && {
            windowExpiresAt: new Date(at.getTime() + WINDOW_MS),
          }),
        },
      });
      return conversation;
    });
    if (opened) this.realtime.inboxChanged(channel.tenantId, opened.id);
    return opened;
  }

  async handleStatus(channel: ResolvedChannel, update: StatusUpdate): Promise<void> {
    const conversationIds = await this.db.withTenants({ tenantIds: [channel.tenantId] }, async (tx) => {
      const where = {
        channelId: channel.id,
        externalMessageId: update.externalMessageId,
        status: { in: PREVIOUS_STATUSES[update.status] },
      };
      const affected = await tx.message.findMany({ where, select: { conversationId: true } });
      await tx.message.updateMany({ where, data: { status: update.status, statusError: update.error ?? null } });
      return affected.map((m) => m.conversationId);
    });
    for (const id of conversationIds) this.realtime.inboxChanged(channel.tenantId, id);
  }

  /**
   * Resolução de identidade (§5.2): identidade no canal → telefone E.164 → hash do CPF → contato novo.
   * Dados existentes nunca são sobrescritos por valores da origem (o atendente tem precedência).
   */
  async resolveContact(tx: TenantTx, tenantId: string, message: ContactSource): Promise<Contact> {
    const profile = message.contactProfile ?? {};
    const identity = await tx.contactIdentity.findUnique({
      where: {
        tenantId_channelType_externalId: {
          tenantId,
          channelType: message.channelType,
          externalId: message.externalContactId,
        },
      },
      include: { contact: true },
    });
    const cpfHash = profile.cpf ? blindIndex(profile.cpf, this.key) : undefined;
    const existing =
      identity?.contact ??
      (profile.phone ? await tx.contact.findFirst({ where: { phone: profile.phone, deletedAt: null } }) : null) ??
      (cpfHash ? await tx.contact.findFirst({ where: { cpfHash, deletedAt: null } }) : null);

    const contact = existing
      ? await tx.contact.update({
          where: { id: existing.id },
          data: {
            lastSeenAt: message.timestamp,
            ...missingFields(existing, profile),
            ...(cpfHash && !existing.cpfHash && { cpfEncrypted: encrypt(profile.cpf!, this.key), cpfHash }),
          },
        })
      : await tx.contact.create({
          data: {
            tenantId,
            name: profile.name,
            email: profile.email,
            firstSeenAt: message.timestamp,
            lastSeenAt: message.timestamp,
            ...(profile.phone && { phone: profile.phone, phoneSource: "channel", phoneStatus: "ok" }),
            ...(cpfHash && { cpfEncrypted: encrypt(profile.cpf!, this.key), cpfHash }),
          },
        });

    if (!identity) {
      await tx.contactIdentity.create({
        data: {
          tenantId,
          contactId: contact.id,
          channelType: message.channelType,
          externalId: message.externalContactId,
          profile: {
            ...profile,
            ...(typeof message.metadata?.username === "string" && { username: message.metadata.username }),
          } as Prisma.InputJsonObject,
        },
      });
    }
    return contact;
  }

  /** Reabre a última conversa do contato no canal ou abre uma nova, com o evento na linha do tempo. */
  async openConversation(tx: TenantTx, channel: ResolvedChannel, contactId: string, at: Date): Promise<OpenedConversation> {
    const latest = await tx.conversation.findFirst({
      where: { contactId, channelId: channel.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });
    if (latest) return { id: latest.id, previousStatus: latest.status };

    const conversation = await tx.conversation.create({
      data: { tenantId: channel.tenantId, contactId, channelId: channel.id, status: "OPEN", createdAt: at },
      select: { id: true },
    });
    await tx.message.create({
      data: {
        tenantId: channel.tenantId,
        conversationId: conversation.id,
        channelId: channel.id,
        direction: "INTERNAL",
        type: "SYSTEM",
        content: { event: "conversation_opened", text: `Conversa aberta via ${CHANNEL_LABEL[channel.type]}` },
        createdAt: at,
      },
    });
    return { id: conversation.id, previousStatus: null };
  }
}

/**
 * As plataformas informam o horário com precisão de segundos. Processada dentro desse segundo, a mensagem
 * usa a hora de chegada (preserva a ordem com respostas do mesmo segundo); se o webhook atrasou, vale o horário original.
 */
function arrivalTime(timestamp: Date): Date {
  const now = new Date();
  const elapsed = now.getTime() - timestamp.getTime();
  return elapsed >= 0 && elapsed < 1_000 ? now : timestamp;
}

/** Palavras de opt-out de campanhas (§5.5), sem diferenciar maiúsculas, acentos ou pontuação. */
function isOptOut(text: string | undefined): boolean {
  // NFD separa os acentos em caracteres próprios, que saem junto com a pontuação: "Sáir!" vira "SAIR".
  const word = text?.normalize("NFD").replace(/[^a-z]/gi, "").toUpperCase();
  return word === "SAIR" || word === "PARAR";
}

function missingFields(contact: Contact, profile: NonNullable<NormalizedMessage["contactProfile"]>) {
  return {
    ...(!contact.name && profile.name && { name: profile.name }),
    ...(!contact.email && profile.email && { email: profile.email }),
    ...(!contact.phone && profile.phone && { phone: profile.phone, phoneSource: "channel", phoneStatus: "ok" }),
  };
}

function contentOf(message: NormalizedMessage): MessageContent & Prisma.InputJsonObject {
  const metadata = message.metadata ?? {};
  const location = metadata.location as MessageContent["location"];
  const filename = typeof metadata.filename === "string" ? metadata.filename : undefined;
  return {
    ...(message.text && { text: message.text }),
    ...(message.media && { media: { ...message.media, ...(filename && { filename }) } }),
    ...(location && { location }),
  };
}
