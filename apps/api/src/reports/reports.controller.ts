import { IFOOD_REVIEW_PERIODS, IfoodReviewAnswerRequest, type IfoodReviewsDto, type RatingsReportDto, REPORT_PERIODS } from "@dishdesk/shared";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { IfoodReviewsService } from "./ifood-reviews.service.js";
import { ReportsService } from "./reports.service.js";

const RatingsQuery = z.object({ tenantId: z.uuid(), period: z.enum(REPORT_PERIODS).default("7d") });
const IfoodReviewsQuery = z.object({ tenantId: z.uuid(), period: z.enum(IFOOD_REVIEW_PERIODS).default("30d") });
const TenantQuery = z.object({ tenantId: z.uuid() });

/** Relatórios do restaurante (só administradores). */
@Controller("reports")
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly ifoodReviews: IfoodReviewsService,
  ) {}

  @Get("ratings")
  ratings(@Query(new ZodPipe(RatingsQuery)) query: z.infer<typeof RatingsQuery>, @CurrentAuth() auth: RequestAuth): Promise<RatingsReportDto> {
    return this.reports.ratings(auth, query.tenantId, query.period);
  }

  @Get("ifood-reviews")
  ifoodReviewList(@Query(new ZodPipe(IfoodReviewsQuery)) query: z.infer<typeof IfoodReviewsQuery>, @CurrentAuth() auth: RequestAuth): Promise<IfoodReviewsDto> {
    return this.ifoodReviews.list(auth, query.tenantId, query.period);
  }

  /** `storeId`: o canal da loja do iFood; `reviewId`: o id da avaliação no iFood. */
  @Post("ifood-reviews/:storeId/:reviewId/answer")
  @HttpCode(204)
  answerIfoodReview(
    @Param("storeId", ParseUUIDPipe) storeId: string,
    @Param("reviewId") reviewId: string,
    @Query(new ZodPipe(TenantQuery)) query: z.infer<typeof TenantQuery>,
    @Body(new ZodPipe(IfoodReviewAnswerRequest)) body: IfoodReviewAnswerRequest,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<void> {
    return this.ifoodReviews.answer(auth, query.tenantId, storeId, reviewId, body.text);
  }
}
