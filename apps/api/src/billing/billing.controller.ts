import { CheckoutRequest, type CheckoutResponse } from "@dishdesk/shared";
import {
  BadGatewayException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Request } from "express";
import { sessionCookie } from "../auth/auth.controller.js";
import { Public } from "../auth/auth.decorators.js";
import { AuthService } from "../auth/auth.service.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { createCheckoutSession } from "./stripe.js";

/**
 * Pagamento da assinatura de um restaurante bloqueado (teste encerrado ou assinatura vencida). Quem paga ainda não
 * tem access token, porque o restaurante bloqueado não recebe um: a rota vale pelo cookie de sessão e por isso
 * fica dentro de /auth, o único caminho para onde o navegador manda o cookie.
 */
@Controller("auth/billing")
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Post("checkout")
  @HttpCode(200)
  async checkout(@Body(new ZodPipe(CheckoutRequest)) body: CheckoutRequest, @Req() request: Request): Promise<CheckoutResponse> {
    if (!this.env.STRIPE_SECRET_KEY) throw new ServiceUnavailableException("O pagamento ainda não está disponível. Fale com a gente.");
    const { user, tenants } = await this.auth.sessionProfile(sessionCookie(request));
    const tenant = tenants.find((t) => t.id === body.tenantId);
    if (!tenant) throw new ForbiddenException("Sem acesso a este restaurante.");
    if (tenant.role !== "ADMIN") throw new ForbiddenException("Só o administrador do restaurante assina o plano.");
    if (!tenant.blockedBy) throw new ConflictException("Este restaurante já está com o acesso liberado.");

    const billing = await this.db.withTenants({ tenantIds: [], userId: user.id }, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { taxId: true, stripeCustomerId: true } }),
    );
    try {
      const url = await createCheckoutSession(this.env, {
        plan: body.plan,
        tenantId: tenant.id,
        tenantName: tenant.name,
        taxId: billing.taxId,
        customerId: billing.stripeCustomerId,
        email: user.email,
      });
      return { url };
    } catch (error) {
      this.logger.error(error);
      throw new BadGatewayException("Não foi possível abrir o pagamento. Tente de novo em instantes.");
    }
  }
}
