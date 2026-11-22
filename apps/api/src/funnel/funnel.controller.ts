import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { z } from "zod";
import { Public } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { AttributionSchema, PUBLIC_RATE_LIMIT } from "../public/public-menu.controller.js";
import { PublicMenuService } from "../public/public-menu.service.js";
import { PublicThrottlerGuard } from "../public/public-throttler.guard.js";
import { BROWSER_STAGES, FunnelService } from "./funnel.service.js";
import { withClientInfo } from "./meta-capi.js";

export const BrowserEvent = z.object({
  eventId: z.uuid(),
  stage: z.enum(BROWSER_STAGES), // PURCHASE e ADD_PAYMENT_INFO só o servidor grava
  sessionId: z.string().trim().min(8).max(64),
  itemId: z.uuid().nullish(),
  cartId: z.uuid().nullish(),
  valueCents: z.number().int().min(0).max(100_000_000).nullish(),
  // Só estas chaves entram; o resto é descartado.
  attribution: AttributionSchema.optional(),
});

/** Eventos do funil vindos do navegador do cardápio público (F7-01), no mesmo limite por IP das outras rotas públicas. */
@Public()
@UseGuards(PublicThrottlerGuard)
@Throttle({ default: { limit: PUBLIC_RATE_LIMIT, ttl: 60_000 } })
@Controller("public/menu/:slug/events")
export class FunnelController {
  constructor(
    private readonly menu: PublicMenuService,
    private readonly funnel: FunnelService,
  ) {}

  @Post()
  @HttpCode(200)
  async record(
    @Param("slug", new ZodPipe(z.string().trim().min(1).max(120))) slug: string,
    @Body(new ZodPipe(BrowserEvent)) body: z.output<typeof BrowserEvent>,
    @Req() request: Request,
  ) {
    // Com o consentimento, o navegador e o IP entram para a Conversions API (F7-04).
    const attribution = withClientInfo(Object.fromEntries(Object.entries(body.attribution ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>, request);
    const recorded = await this.menu.withStore(slug, (tx, store) =>
      this.funnel.record(tx, store.tenantId, {
        eventId: body.eventId,
        stage: body.stage,
        channel: "WEB",
        sessionId: body.sessionId,
        menuItemId: body.itemId,
        cartId: body.cartId,
        valueCents: body.valueCents,
        attribution,
      }),
    );
    return { recorded };
  }
}
