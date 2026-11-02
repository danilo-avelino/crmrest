import type { Prisma, TenantTx } from "@dishdesk/database";
import type { OrderStatus } from "@dishdesk/database/enums";
import { automationMessagesOf, fillMessage, type IfoodChatOutboxItem, type IfoodChatSendResult, reviewInviteOf } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { z } from "zod";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { promisedAt } from "../orders/forecast.js";
import { QUEUES } from "../queues/queues.module.js";
import { tenantSettings } from "./automation.js";

const SWEEP_MS = 60_000;
/** Espera depois da entrega (ou do horário prometido, se o iFood não avisar a entrega). */
export const REVIEW_INVITE_DELAY_MS = 10 * 60_000;
/** Quanto tempo o convite espera um painel aberto, e o painel tem para confirmar o envio. Depois disso, é descartado. */
export const REVIEW_INVITE_WAIT_MS = 30 * 60_000;
/** Pedidos olhados pela varredura; os mais antigos que isso nunca recebem convite. */
const LOOKBACK_MS = 24 * 60 * 60_000;
/** Por pedido de envio do painel: as respostas da equipe não ficam atrás de uma fila de convites. */
const CLAIM_BATCH = 3;

const OrderCustomer = z.looseObject({ customer: z.looseObject({ name: z.string() }).nullish() });

type InviteOrder = { status: OrderStatus; deliveredAt: Date | null; raw: unknown };
type InviteDecision = { dueAt: Date; status: "PENDING" | "EXPIRED" | "SKIPPED"; reason?: "canceled" | "late" | "not_delivered" };

/**
 * O que fazer com o convite deste pedido agora; null = ainda não é a hora, ou não há horário nenhum para contar.
 * Pedido sem o aviso de entrega conta do horário prometido e só recebe o convite se já saiu: o que ainda está na loja
 * depois do prometido com certeza atrasou.
 */
export function reviewInviteDecision(order: InviteOrder, now: Date): InviteDecision | null {
  const promised = promisedAt(order.raw);
  const base = order.deliveredAt ?? promised;
  if (!base) return null;
  const dueAt = new Date(base.getTime() + REVIEW_INVITE_DELAY_MS);
  if (now < dueAt) return null;
  if (order.status === "CANCELED") return { dueAt, status: "SKIPPED", reason: "canceled" };
  if (order.deliveredAt && promised && order.deliveredAt > promised) return { dueAt, status: "SKIPPED", reason: "late" };
  if (!order.deliveredAt && order.status !== "DISPATCHED" && order.status !== "DELIVERED") return { dueAt, status: "SKIPPED", reason: "not_delivered" };
  if (now.getTime() - dueAt.getTime() > REVIEW_INVITE_WAIT_MS) return { dueAt, status: "EXPIRED" };
  return { dueAt, status: "PENDING" };
}

/**
 * Convite de avaliação no iFood (E32): a varredura decide o convite de cada pedido entregue e registra o desfecho. Quem
 * envia é o painel com a extensão (IfoodChatService.claim): sem painel aberto dentro do prazo, o convite é descartado.
 */
@Injectable()
export class ReviewInviteService implements OnModuleInit {
  private readonly logger = new Logger(ReviewInviteService.name);

  constructor(
    private readonly db: DatabaseService,
    @InjectQueue(QUEUES.automations) private readonly automations: Queue,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.automations.upsertJobScheduler("review-invite-sweep", { every: SWEEP_MS }, { name: "review-invite-sweep" });
  }

  async sweep(now = new Date()): Promise<void> {
    if (!this.env.IFOOD_CHAT_BRIDGE) return;
    const tenants = await this.db.client.$queryRaw<{ tenant_id: string }[]>`SELECT DISTINCT tenant_id FROM app.ifood_merchants()`;
    for (const { tenant_id: tenantId } of tenants) {
      try {
        await this.sweepTenant(tenantId, now);
      } catch (error) {
        this.logger.warn(`Convites de avaliação do restaurante ${tenantId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async sweepTenant(tenantId: string, now = new Date()): Promise<void> {
    await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const settings = await tenantSettings(tx, tenantId);
      const { enabled } = reviewInviteOf(settings);
      const limit = new Date(now.getTime() - REVIEW_INVITE_WAIT_MS);
      await tx.reviewInvite.updateMany({
        where: { tenantId, status: "PENDING", claimedAt: null, ...(enabled && { dueAt: { lt: limit } }) },
        data: { status: "EXPIRED" },
      });
      await tx.reviewInvite.updateMany({
        where: { tenantId, status: "PENDING", claimedAt: { lt: limit } },
        data: { status: "FAILED", reason: "O painel não confirmou o envio." },
      });
      if (!enabled) return;

      const since = new Date(now.getTime() - LOOKBACK_MS);
      const orders = await tx.order.findMany({
        where: {
          tenantId,
          channel: { type: "IFOOD" },
          displayCode: { not: null },
          reviewInvite: { is: null },
          OR: [{ deliveredAt: { gte: since } }, { deliveredAt: null, placedAt: { gte: since } }],
        },
        select: { id: true, status: true, deliveredAt: true, raw: true, displayCode: true, placedAt: true, channel: { select: { connectedAt: true } } },
      });
      const { reviewInvite } = automationMessagesOf(settings);
      const rows: Prisma.ReviewInviteCreateManyInput[] = [];
      for (const order of orders) {
        // Pedido feito antes de a loja ser conectada: sem convite, como nos avisos do pedido.
        if (order.channel.connectedAt && order.placedAt < order.channel.connectedAt) continue;
        const decision = reviewInviteDecision(order, now);
        if (!decision) continue;
        const text = decision.status === "PENDING" ? fillMessage(reviewInvite, { pedido: order.displayCode! }) : null;
        rows.push({ tenantId, orderId: order.id, ...decision, text });
      }
      if (rows.length) await tx.reviewInvite.createMany({ data: rows, skipDuplicates: true });
    });
  }
}

/** Convites prontos para o painel digitar, cada um no chat do próprio pedido e só se o cliente da lista do widget for o dele. */
export async function claimReviewInvites(tx: TenantTx, now: Date): Promise<IfoodChatOutboxItem[]> {
  const pending = await tx.reviewInvite.findMany({
    where: { status: "PENDING", claimedAt: null, dueAt: { gte: new Date(now.getTime() - REVIEW_INVITE_WAIT_MS) } },
    orderBy: { dueAt: "asc" },
    take: CLAIM_BATCH,
    select: { id: true, text: true, order: { select: { displayCode: true, raw: true, contact: { select: { name: true } } } } },
  });
  const items: IfoodChatOutboxItem[] = [];
  for (const invite of pending) {
    // Com dois painéis abertos, só o primeiro leva o convite.
    const { count } = await tx.reviewInvite.updateMany({ where: { id: invite.id, status: "PENDING", claimedAt: null }, data: { claimedAt: now } });
    if (!count) continue;
    const customer = OrderCustomer.safeParse(invite.order.raw).data?.customer?.name ?? invite.order.contact.name ?? "";
    items.push({ messageId: invite.id, orderCode: invite.order.displayCode!, text: invite.text!, customer });
  }
  return items;
}

/** Registra o que o painel contou do envio. Devolve false se o id não é de um convite. O que falhou por demora ainda pode ter saído. */
export async function settleReviewInvite(tx: TenantTx, id: string, body: IfoodChatSendResult, now: Date): Promise<boolean> {
  const invite = await tx.reviewInvite.findUnique({ where: { id }, select: { id: true } });
  if (!invite) return false;
  await tx.reviewInvite.updateMany({
    where: { id, status: { in: ["PENDING", "FAILED"] } },
    data:
      body.status === "SENT"
        ? { status: "SENT", sentAt: now, reason: null }
        : { status: "FAILED", reason: body.error ?? "O widget do iFood não aceitou a mensagem." },
  });
  return true;
}
