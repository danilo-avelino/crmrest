import { type RatingsReportDto, REPORT_PERIODS } from "@comanda/shared";
import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { ReportsService } from "./reports.service.js";

const RatingsQuery = z.object({ tenantId: z.uuid(), period: z.enum(REPORT_PERIODS).default("7d") });

/** Relatórios do restaurante (só administradores). */
@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("ratings")
  ratings(@Query(new ZodPipe(RatingsQuery)) query: z.infer<typeof RatingsQuery>, @CurrentAuth() auth: RequestAuth): Promise<RatingsReportDto> {
    return this.reports.ratings(auth, query.tenantId, query.period);
  }
}
