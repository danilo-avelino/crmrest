import type { TenantTx } from "@dishdesk/database";
import { AUTO_TAG_RULES, MANUAL_TAGS } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import * as Sentry from "@sentry/nestjs";
import type { Queue } from "bullmq";
import { DatabaseService } from "../core/database.service.js";
import { QUEUES } from "../queues/queues.module.js";

const DAY = 24 * 60 * 60_000;

/**
 * Recalcula as tags automáticas (AUTO_TAG_INFO) de todos os clientes dos restaurantes da transação e grava só as que
 * mudaram. Pedidos cancelados e clientes anonimizados ficam de fora. As tags manuais (MANUAL_TAGS) ficam como estão.
 */
export async function refreshContactTags(tx: TenantTx, now = new Date()): Promise<void> {
  const rules = AUTO_TAG_RULES;
  const since = (days: number) => new Date(now.getTime() - days * DAY);
  await tx.$executeRaw`
    WITH stats AS (
      SELECT o.contact_id,
        count(*) AS orders,
        count(*) FILTER (WHERE o.placed_at >= ${since(rules.recurringDays)}) AS recent_orders,
        min(o.placed_at) AS first_order,
        max(o.placed_at) AS last_order
      FROM orders o
      WHERE o.status <> 'CANCELED'
      GROUP BY o.contact_id
    ),
    -- at_least: quantos clientes do restaurante têm tantos pedidos quanto este, ou mais (os empatados contam juntos).
    ranked AS (
      SELECT s.*,
        count(*) OVER (PARTITION BY c.tenant_id ORDER BY s.orders DESC) AS at_least,
        count(*) OVER (PARTITION BY c.tenant_id) AS customers
      FROM stats s JOIN contacts c ON c.id = s.contact_id
      WHERE c.deleted_at IS NULL
    ),
    last_rating AS (
      SELECT DISTINCT ON (cv.contact_id) cv.contact_id, r.score
      FROM ratings r JOIN conversations cv ON cv.id = r.conversation_id
      ORDER BY cv.contact_id, r.created_at DESC, r.id DESC
    ),
    computed AS (
      SELECT c.id, ARRAY(
          SELECT manual.tag FROM unnest(${[...MANUAL_TAGS]}::text[]) WITH ORDINALITY AS manual(tag, position)
          WHERE manual.tag = ANY(c.tags) ORDER BY manual.position
        ) || array_remove(ARRAY[
          CASE WHEN k.orders >= ${rules.vipMinOrders} AND k.at_least <= ceil(k.customers * ${rules.vipTopPercent} / 100.0) THEN 'VIP' END,
          CASE WHEN k.recent_orders >= ${rules.recurringOrders} THEN 'Recorrente' END,
          CASE WHEN k.first_order >= ${since(rules.newDays)} THEN 'Novo' END,
          CASE WHEN k.last_order < ${since(rules.goneDays)} THEN 'Sumido' END,
          CASE WHEN r.score <= ${rules.upsetMaxScore} THEN 'Insatisfeito' END
        ], NULL) AS tags
      FROM contacts c
      LEFT JOIN ranked k ON k.contact_id = c.id
      LEFT JOIN last_rating r ON r.contact_id = c.id
      WHERE c.deleted_at IS NULL
    )
    UPDATE contacts SET tags = computed.tags
    FROM computed
    WHERE contacts.id = computed.id AND contacts.tags IS DISTINCT FROM computed.tags`;
}

/** Mantém as tags automáticas em dia: as regras dependem do tempo (Novo, Sumido) e dos outros clientes (VIP). */
@Injectable()
export class ContactTagsService implements OnModuleInit {
  private readonly logger = new Logger(ContactTagsService.name);

  constructor(
    private readonly db: DatabaseService,
    @InjectQueue(QUEUES.automations) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    // De hora em hora. Idempotente entre réplicas.
    await this.queue.upsertJobScheduler("contact-tags", { pattern: "0 * * * *" }, { name: "contact-tags" });
  }

  async refreshAll(): Promise<void> {
    const tenants = await this.db.client.$queryRaw<{ id: string }[]>`SELECT id FROM app.active_tenants()`;
    for (const { id: tenantId } of tenants) {
      try {
        await this.db.withTenants({ tenantIds: [tenantId] }, (tx) => refreshContactTags(tx));
      } catch (error) {
        // Segue para os outros restaurantes; a próxima hora tenta de novo.
        this.logger.warn({ tenantId, err: error }, "Tags dos clientes não recalculadas");
        Sentry.captureException(error, { tags: { tenantId } });
      }
    }
  }
}
