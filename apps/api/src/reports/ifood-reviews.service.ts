import type { IfoodReviewDto, IfoodReviewPeriod, IfoodReviewsDto } from "@dishdesk/shared";
import { Injectable, Logger, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { IfoodAuthService, type IfoodStore } from "../connectors/ifood-auth.service.js";
import { IfoodError, type IfoodReview } from "../connectors/ifood.client.js";
import { DatabaseService } from "../core/database.service.js";
import { requireTenantAdmin } from "../settings/tenant-admin.js";

const DAY = 24 * 60 * 60 * 1000;
const PERIOD_DAYS: Record<IfoodReviewPeriod, number> = { "7d": 7, "30d": 30, "90d": 90 };
/** Prazo do iFood para a loja responder uma avaliação. */
const REPLY_DAYS = 5;

type Store = IfoodStore & { name: string; externalId: string };

/**
 * Aba Avaliações → iFood: as avaliações das lojas do iFood, lidas direto da Review API a cada consulta (o Dish Desk não
 * guarda cópia), e a resposta da loja. Só administradores.
 */
@Injectable()
export class IfoodReviewsService {
  private readonly logger = new Logger(IfoodReviewsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly ifood: IfoodAuthService,
  ) {}

  async list(auth: RequestAuth, tenantId: string, period: IfoodReviewPeriod, now = new Date()): Promise<IfoodReviewsDto> {
    requireTenantAdmin(auth, tenantId);
    const stores = await this.stores(auth, tenantId);
    const from = new Date(now.getTime() - PERIOD_DAYS[period] * DAY);
    const result: IfoodReviewsDto = { stores: [], unavailable: [], reviews: [] };
    if (!this.ifood.configured) return result;

    await Promise.all(
      stores.map(async (store) => {
        const client = this.ifood.clientFor(store);
        try {
          const [reviews, summary] = await Promise.all([client.reviews(store.externalId, from, now), client.reviewSummary(store.externalId)]);
          result.stores.push({
            id: store.id,
            name: store.name,
            score: summary.score ?? null,
            validReviews: summary.validReviewsCount,
            totalReviews: summary.totalReviewsCount,
          });
          result.reviews.push(...reviews.map((review) => toDto(review, store)));
        } catch (error) {
          const forbidden = error instanceof IfoodError && (error.status === 401 || error.status === 403);
          if (!forbidden) this.logger.warn(`avaliações do iFood (${store.id}): ${error instanceof Error ? error.message : String(error)}`);
          result.unavailable.push({ id: store.id, name: store.name, reason: forbidden ? "forbidden" : "error" });
        }
      }),
    );
    result.reviews.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return result;
  }

  async answer(auth: RequestAuth, tenantId: string, storeId: string, reviewId: string, text: string): Promise<void> {
    requireTenantAdmin(auth, tenantId);
    const store = (await this.stores(auth, tenantId)).find((s) => s.id === storeId);
    if (!store || !this.ifood.configured) throw new NotFoundException("Loja do iFood não encontrada.");
    try {
      await this.ifood.clientFor(store).answerReview(store.externalId, reviewId, text);
    } catch (error) {
      if (!(error instanceof IfoodError)) throw error;
      this.logger.warn(`iFood recusou a resposta da avaliação ${reviewId}: ${error.message}`);
      throw new UnprocessableEntityException(ANSWER_REFUSED[error.status] ?? "O iFood não aceitou a resposta. Tente de novo em instantes.");
    }
  }

  /** Lojas do iFood conectadas no restaurante. */
  private stores(auth: RequestAuth, tenantId: string): Promise<Store[]> {
    return this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, (tx) =>
      tx.channel.findMany({
        where: { tenantId, type: "IFOOD", status: "CONNECTED", deletedAt: null },
        select: { id: true, tenantId: true, name: true, externalId: true },
        orderBy: { name: "asc" },
      }),
    );
  }
}

const ANSWER_REFUSED: Record<number, string> = {
  400: "A resposta precisa ter de 10 a 300 caracteres.",
  403: "O iFood ainda não liberou as respostas de avaliações para o Dish Desk.",
  404: "O iFood não encontrou esta avaliação.",
  409: "Esta avaliação não aceita mais resposta: já foi respondida ou publicada.",
  422: "O iFood recusou a resposta. Evite dados pessoais do cliente, links e linguagem ofensiva; se a avaliação já foi publicada, ela não aceita mais resposta.",
};

function toDto(review: IfoodReview, store: Store): IfoodReviewDto {
  const status = review.status ?? "PUBLISHED";
  return {
    id: review.id,
    storeId: store.id,
    storeName: store.name,
    score: review.score,
    comment: review.comment?.trim() || null,
    customerName: review.customerName ?? null,
    createdAt: review.createdAt,
    status,
    visibility: review.visibility ?? null,
    orderCode: review.order?.shortId ?? null,
    answers: (review.questions ?? []).flatMap((question) => (question.answers ?? []).map((answer) => answer.title)),
    replies: (review.replies ?? []).map((reply) => ({ text: reply.text, from: reply.from ?? null, createdAt: reply.createdAt ?? null })),
    replyBy: status === "NOT_REPLIED" ? new Date(new Date(review.createdAt).getTime() + REPLY_DAYS * DAY).toISOString() : null,
  };
}
