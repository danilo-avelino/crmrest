import type { TenantTx } from "@dishdesk/database";
import { adminNotificationsOf, type MessageContent, type RatingsReportDto, TEAM_REASONS } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, type OnModuleInit, UnprocessableEntityException } from "@nestjs/common";
import * as Sentry from "@sentry/nestjs";
import type { Queue } from "bullmq";
import { PermanentSendError } from "../connectors/connector.js";
import { ConnectorsService } from "../connectors/connectors.service.js";
import { DatabaseService } from "../core/database.service.js";
import { type AdminMessageJob, QUEUES } from "../queues/queues.module.js";
import { ReportsService } from "../reports/reports.service.js";

const DAY = 24 * 60 * 60 * 1000;
const RULE = "━━━━━━━━━━━━━━━";
const FOOTER = "_Mensagem automática do Dish Desk, enviada pelo WhatsApp do restaurante. Para não receber mais, desligue em Configurações → Notificações._";

/** O WhatsApp do restaurante por onde saem as notificações: o primeiro conectado (ou com erro, que ainda pode enviar). */
export function notificationChannelOf(tx: TenantTx, tenantId: string) {
  return tx.channel.findFirst({
    where: { tenantId, type: "WHATSAPP", deletedAt: null, status: { not: "DISCONNECTED" } },
    orderBy: { id: "asc" },
    select: { id: true, name: true, externalId: true, credentials: true },
  });
}

const number = (value: number) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(value);
const percent = (part: number, total: number) => (total ? Math.round((part / total) * 100) : 0);
const dayMonth = (at: Date) => new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" }).format(at);
const clock = (at: Date) => new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }).format(at);
const bar = (value: number) => "▰".repeat(Math.round(value / 10)) + "▱".repeat(10 - Math.round(value / 10));

function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** Alerta de má conduta: a resposta que a revisão da IA bloqueou, quem escreveu e para quem. */
export function misconductText(alert: { restaurant: string; agent: string | null; contact: string | null; original: string; reason: string; at: Date }): string {
  const original = alert.original.length > 300 ? `${alert.original.slice(0, 300)}…` : alert.original;
  return [
    "🚨 *Alerta de má conduta · Dish Desk*",
    `🍽️ *${alert.restaurant}*`,
    "",
    `A IA bloqueou uma resposta de *${alert.agent ?? "um atendente"}* ao cliente *${alert.contact ?? "sem nome"}*. A mensagem *não foi enviada*.`,
    "",
    `📝 *Mensagem:* "${original}"`,
    `❗ *Motivo:* ${alert.reason}`,
    `🕐 ${dayMonth(alert.at)} às ${clock(alert.at)}`,
    "",
    "Os alertas ficam em Avaliações → Atendimento.",
    "",
    FOOTER,
  ].join("\n");
}

/** Relatório semanal: atendimento, tempo de resposta, motivos dos chamados e avaliações dos últimos 7 dias. */
export function weeklyReportText(restaurant: string, conversations: number, report: RatingsReportDto, from: Date, to: Date): string {
  const { summary, unanswered, ai } = report;
  const lines = ["📊 *Relatório semanal · Dish Desk*", `🍽️ *${restaurant}*`, `📅 ${dayMonth(from)} a ${dayMonth(to)} (últimos 7 dias)`, "", RULE, ""];

  lines.push("💬 *ATENDIMENTO*", `• *${number(conversations)}* ${conversations === 1 ? "conversa" : "conversas"}`);
  lines.push(`• *${number(summary.handoffs)}* ${summary.handoffs === 1 ? "chamado" : "chamados"} para a equipe`);
  if (ai?.evaluations) lines.push(`• 🤖 *${percent(ai.onlyAi, ai.evaluations)}%* dos atendimentos só com a IA`);

  lines.push("", "⏱️ *TEMPO DE RESPOSTA*");
  lines.push(summary.averageResponseSeconds === null ? "• Sem chamados respondidos" : `• Média da equipe: *${duration(summary.averageResponseSeconds)}*`);
  if (unanswered.length) lines.push(`• ⚠️ *${number(unanswered.length)}* ${unanswered.length === 1 ? "chamado ficou" : "chamados ficaram"} sem resposta`);

  const reasons = ai?.teamReasons ?? [];
  if (reasons.length) {
    const total = reasons.reduce((sum, row) => sum + row.count, 0);
    lines.push("", "📌 *MOTIVOS DOS CHAMADOS*");
    for (const row of reasons) {
      const share = percent(row.count, total);
      lines.push(TEAM_REASONS[row.reason], `${bar(share)} *${share}%* (${number(row.count)})`);
    }
  }

  const ratings = summary.averageScore !== null ? `• Clientes: *${number(summary.averageScore)}* de 5 (${number(summary.ratings)} ${summary.ratings === 1 ? "nota" : "notas"})` : null;
  const aiScore = ai?.averageScore != null ? `• IA: *${number(ai.averageScore)}* de 5 (${number(ai.evaluations)} ${ai.evaluations === 1 ? "atendimento" : "atendimentos"})` : null;
  const resolved = ai?.evaluations ? `• ✅ *${percent(ai.resolved, ai.evaluations)}%* dos problemas resolvidos` : null;
  if (ratings || aiScore || resolved) lines.push("", "⭐ *AVALIAÇÕES*", ...[ratings, aiScore, resolved].filter((line) => line !== null));

  if (ai?.misconduct.length) {
    lines.push("", `🚨 *${number(ai.misconduct.length)}* ${ai.misconduct.length === 1 ? "alerta" : "alertas"} de má conduta na semana`);
  }
  lines.push("", RULE, FOOTER);
  return lines.join("\n");
}

/**
 * Notificações ao administrador pelo WhatsApp do próprio restaurante (Configurações → Notificações): o alerta de má
 * conduta e o relatório semanal, toda segunda às 9h. Cada número é um job "admin-message", que tenta de novo sozinho.
 */
@Injectable()
export class AdminNotificationsService implements OnModuleInit {
  private readonly logger = new Logger(AdminNotificationsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly connectors: ConnectorsService,
    private readonly reports: ReportsService,
    @InjectQueue(QUEUES.automations) private readonly queue: Queue<AdminMessageJob>,
  ) {}

  async onModuleInit(): Promise<void> {
    // Toda segunda às 9h. Idempotente entre réplicas.
    await this.queue.upsertJobScheduler("admin-weekly-report", { pattern: "0 9 * * 1", tz: "America/Sao_Paulo" }, { name: "admin-weekly-report" });
  }

  /** Resposta bloqueada por má conduta (AiReviewService): avisa os números do administrador, se ele quiser. */
  async misconduct(tenantId: string, messageId: string): Promise<void> {
    const text = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const message = await tx.message.findUnique({
        where: { id: messageId },
        select: {
          content: true,
          sentByUserId: true,
          createdAt: true,
          tenant: { select: { name: true, settings: true } },
          conversation: { select: { contact: { select: { name: true } } } },
        },
      });
      if (!message || !adminNotificationsOf(message.tenant.settings).misconduct) return null;
      const agent = message.sentByUserId
        ? await tx.tenantMember.findFirst({ where: { tenantId, userId: message.sentByUserId }, select: { user: { select: { name: true } } } })
        : null;
      const content = message.content as MessageContent;
      return misconductText({
        restaurant: message.tenant.name,
        agent: agent?.user.name ?? null,
        contact: message.conversation.contact.name,
        original: content.original ?? "",
        reason: content.misconduct ?? "",
        at: message.createdAt,
      });
    });
    if (text) await this.enqueue(tenantId, text);
  }

  /** Segunda às 9h: o relatório de cada restaurante que quer recebê-lo. */
  async weeklyAll(now = new Date()): Promise<void> {
    const tenants = await this.db.client.$queryRaw<{ id: string }[]>`SELECT id FROM app.active_tenants()`;
    for (const { id: tenantId } of tenants) {
      try {
        await this.weekly(tenantId, now);
      } catch (error) {
        // Segue para os outros restaurantes.
        this.logger.warn({ tenantId, err: error }, "Relatório semanal não enviado");
        Sentry.captureException(error, { tags: { tenantId } });
      }
    }
  }

  /** O relatório dos últimos 7 dias; `test` (botão da aba Notificações) envia mesmo com o relatório desligado. */
  async weekly(tenantId: string, now = new Date(), test = false): Promise<number> {
    const scope = { tenantIds: [tenantId] };
    const from = new Date(now.getTime() - 7 * DAY);
    const tenant = await this.db.withTenants(scope, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true, settings: true } });
      const [{ total }] = await tx.$queryRaw<[{ total: number }]>`
        SELECT count(DISTINCT conversation_id)::int AS total FROM messages
        WHERE tenant_id = ${tenantId}::uuid AND direction = 'INBOUND' AND created_at >= ${from}`;
      return { ...tenant, conversations: total };
    });
    const settings = adminNotificationsOf(tenant.settings);
    if (!test && !settings.weeklyReport) return 0;
    const report = await this.reports.report(scope, tenantId, from);
    return this.enqueue(tenantId, weeklyReportText(tenant.name, tenant.conversations, report, from, now), test);
  }

  /** Um job por número do administrador; `strict` recusa quando não há para quem nem por onde enviar. */
  private async enqueue(tenantId: string, text: string, strict = false): Promise<number> {
    const { phones, channel } = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
      return { phones: adminNotificationsOf(tenant.settings).phones, channel: await notificationChannelOf(tx, tenantId) };
    });
    if (strict && !phones.length) throw new UnprocessableEntityException("Cadastre e salve pelo menos um número.");
    if (strict && !channel) throw new UnprocessableEntityException("Conecte um WhatsApp em Integrações para enviar as notificações.");
    if (!channel) return 0;
    await this.queue.addBulk(phones.map((phone) => ({ name: "admin-message", data: { tenantId, phone, text } })));
    return phones.length;
  }

  /** Job "admin-message": envia pelo WhatsApp do restaurante. Falha permanente (número inválido, canal recusado) não repete. */
  async send({ tenantId, phone, text }: AdminMessageJob): Promise<void> {
    const channel = await this.db.withTenants({ tenantIds: [tenantId] }, (tx) => notificationChannelOf(tx, tenantId));
    if (!channel) return; // o WhatsApp foi desconectado depois do agendamento
    const secrets = this.connectors.secrets(channel.credentials);
    const connector = this.connectors.get("WHATSAPP", secrets)!;
    // WhatsApp por QR Code: quem envia é a instância da Evolution, não o número.
    const target = { externalChannelId: secrets.instance ?? channel.externalId, recipientId: phone.replace(/^\+/, ""), accessToken: secrets.accessToken };
    try {
      await connector.send(target, { type: "TEXT", text });
    } catch (error) {
      if (!(error instanceof PermanentSendError)) throw error;
      this.logger.warn({ tenantId, err: error }, "Notificação ao administrador não enviada");
    }
  }
}
