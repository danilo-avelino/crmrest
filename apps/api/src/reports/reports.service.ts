import type { AgentMetrics, RatingsReportDto, ReportPeriod } from "@dishdesk/shared";
import { Injectable } from "@nestjs/common";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { localDate } from "../automations/automation.js";
import { DatabaseService } from "../core/database.service.js";
import { requireTenantAdmin } from "../settings/tenant-admin.js";

const DAY = 24 * 60 * 60 * 1000;

type HandoffRow = { handed_at: Date; replied_at: Date | null; user_id: string | null };
type UnansweredRow = { conversation_id: string; called_at: Date; after_hours: boolean; contact_name: string | null };
type RatingRow = {
  id: string;
  score: number;
  created_at: Date;
  conversation_id: string;
  contact_name: string | null;
  order_code: string | null;
  user_id: string | null;
};

/**
 * Aba Avaliações: notas e tempo de resposta da equipe. O tempo conta do evento "handoff" (a automação passou o
 * atendimento à equipe) até a primeira resposta de uma pessoa; a nota vai para quem respondeu por último no atendimento.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly db: DatabaseService) {}

  async ratings(auth: RequestAuth, tenantId: string, period: ReportPeriod, now = new Date()): Promise<RatingsReportDto> {
    requireTenantAdmin(auth, tenantId);
    const from = periodStart(period, now);
    return this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, async (tx) => {
      // Cada passagem à equipe e a primeira resposta de uma pessoa depois dela (antes da próxima passagem na conversa).
      const handoffs = await tx.$queryRaw<HandoffRow[]>`
        SELECT h.created_at AS handed_at, r.created_at AS replied_at, r.sent_by_user_id AS user_id
        FROM messages h
        LEFT JOIN LATERAL (
          SELECT m.created_at, m.sent_by_user_id
          FROM messages m
          WHERE m.conversation_id = h.conversation_id
            AND m.direction = 'OUTBOUND' AND m.sent_by_user_id IS NOT NULL AND m.created_at > h.created_at
            AND NOT EXISTS (
              SELECT 1 FROM messages n
              WHERE n.conversation_id = h.conversation_id AND n.type = 'SYSTEM' AND n.content->>'event' = 'handoff'
                AND n.created_at > h.created_at AND n.created_at < m.created_at
            )
          ORDER BY m.created_at
          LIMIT 1
        ) r ON true
        WHERE h.tenant_id = ${tenantId}::uuid AND h.type = 'SYSTEM' AND h.content->>'event' = 'handoff' AND h.created_at >= ${from}`;

      // Cada nota e quem respondeu por último antes dela, no mesmo atendimento (depois da última passagem à equipe).
      const ratings = await tx.$queryRaw<RatingRow[]>`
        SELECT r.id, r.score, r.created_at, r.conversation_id, c.name AS contact_name, o.display_code AS order_code,
               a.sent_by_user_id AS user_id
        FROM ratings r
        JOIN conversations cv ON cv.id = r.conversation_id
        JOIN contacts c ON c.id = cv.contact_id
        LEFT JOIN orders o ON o.id = r.order_id
        LEFT JOIN LATERAL (
          SELECT m.sent_by_user_id
          FROM messages m
          WHERE m.conversation_id = r.conversation_id
            AND m.direction = 'OUTBOUND' AND m.sent_by_user_id IS NOT NULL AND m.created_at < r.created_at
            AND m.created_at > COALESCE((
              SELECT max(h.created_at) FROM messages h
              WHERE h.conversation_id = r.conversation_id AND h.type = 'SYSTEM' AND h.content->>'event' = 'handoff'
                AND h.created_at < r.created_at
            ), '-infinity')
          ORDER BY m.created_at DESC
          LIMIT 1
        ) a ON true
        WHERE r.tenant_id = ${tenantId}::uuid AND r.created_at >= ${from}
        ORDER BY r.created_at DESC`;

      // Chamadas sem resposta humana até o fim do dia (Brasília): uma por conversa e dia, a primeira chamada do dia.
      const unanswered = await tx.$queryRaw<UnansweredRow[]>`
        WITH calls AS (
          SELECT e.conversation_id, e.created_at, e.direction = 'OUTBOUND' AS after_hours,
                 (date_trunc('day', e.created_at AT TIME ZONE 'America/Sao_Paulo') + interval '1 day') AT TIME ZONE 'America/Sao_Paulo' AS day_end
          FROM messages e
          WHERE e.tenant_id = ${tenantId}::uuid AND e.created_at >= ${from}
            AND ((e.type = 'SYSTEM' AND e.content->>'event' = 'handoff')
              OR (e.direction = 'OUTBOUND' AND e.content->>'automation' = 'after_hours'))
        )
        SELECT DISTINCT ON (c.conversation_id, c.day_end)
               c.conversation_id, c.created_at AS called_at, c.after_hours, ct.name AS contact_name
        FROM calls c
        JOIN conversations cv ON cv.id = c.conversation_id
        JOIN contacts ct ON ct.id = cv.contact_id
        WHERE NOT EXISTS (
          SELECT 1 FROM messages m
          WHERE m.conversation_id = c.conversation_id AND m.direction = 'OUTBOUND' AND m.sent_by_user_id IS NOT NULL
            AND m.created_at > c.created_at AND m.created_at < c.day_end
        )
        ORDER BY c.conversation_id, c.day_end, c.created_at`;

      const userIds = [...new Set([...handoffs, ...ratings].flatMap((row) => (row.user_id ? [row.user_id] : [])))];
      const members = await tx.tenantMember.findMany({
        where: { tenantId, userId: { in: userIds } },
        select: { user: { select: { id: true, name: true } } },
      });
      const names = new Map(members.map((member) => [member.user.id, member.user.name]));
      const nameOf = (userId: string | null) => (userId ? (names.get(userId) ?? "Ex-atendente") : null);

      const answered = handoffs.filter((row) => row.replied_at);
      const agents = [...new Set([...answered, ...ratings].map((row) => row.user_id))]
        .map((userId) => ({
          userId,
          name: nameOf(userId) ?? "Sem resposta da equipe",
          ...metrics(
            ratings.filter((row) => row.user_id === userId),
            answered.filter((row) => row.user_id === userId),
          ),
        }))
        .sort((a, b) => (a.userId === null ? 1 : b.userId === null ? -1 : a.name.localeCompare(b.name, "pt-BR")));

      return {
        summary: { ...metrics(ratings, answered), handoffs: handoffs.length },
        agents,
        unanswered: unanswered
          .sort((a, b) => b.called_at.getTime() - a.called_at.getTime())
          .map((row) => ({
            conversationId: row.conversation_id,
            contactName: row.contact_name,
            calledAt: row.called_at.toISOString(),
            afterHours: row.after_hours,
          })),
        recent: ratings.slice(0, 50).map((row) => ({
          id: row.id,
          score: row.score,
          createdAt: row.created_at.toISOString(),
          conversationId: row.conversation_id,
          contactName: row.contact_name,
          agentName: nameOf(row.user_id),
          orderCode: row.order_code,
        })),
      };
    });
  }
}

function metrics(ratings: RatingRow[], answered: HandoffRow[]): AgentMetrics {
  const average = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
  const seconds = answered.map((row) => (row.replied_at!.getTime() - row.handed_at.getTime()) / 1000);
  return {
    ratings: ratings.length,
    averageScore: average(ratings.map((row) => row.score)),
    answered: answered.length,
    averageResponseSeconds: average(seconds),
  };
}

/** Hoje começa à 00h de Brasília; 7 e 30 dias contam para trás a partir de agora. */
export function periodStart(period: ReportPeriod, now: Date): Date {
  if (period === "today") return new Date(`${localDate(now)}T00:00:00-03:00`);
  return new Date(now.getTime() - (period === "7d" ? 7 : 30) * DAY);
}
