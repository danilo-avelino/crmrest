import type { DemoSummary } from "@dishdesk/database";
import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import type { z } from "zod";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { SimulateRequest } from "./demo-scripts.js";
import { DemoService } from "./demo.service.js";

/** Ações da conta de demonstração (menu escondido do painel): só funcionam no restaurante da demo. */
@Controller("demo")
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  /** Volta a demo ao estado inicial, com as datas contadas a partir de agora. */
  @Post(":tenantId/reset")
  @HttpCode(200)
  reset(@Param("tenantId", ParseUUIDPipe) tenantId: string, @CurrentAuth() auth: RequestAuth): Promise<DemoSummary> {
    return this.demo.reset(auth, tenantId);
  }

  /** Um cliente começa a escrever agora (roteiro), para mostrar o atendimento em tempo real. */
  @Post(":tenantId/simulate")
  @HttpCode(200)
  simulate(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body(new ZodPipe(SimulateRequest)) body: z.infer<typeof SimulateRequest>,
    @CurrentAuth() auth: RequestAuth,
  ): Promise<{ conversationId: string }> {
    return this.demo.simulate(auth, tenantId, body.scenario);
  }
}
