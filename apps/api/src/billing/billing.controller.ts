import { CheckoutRequest, type CheckoutResponse, TRUST_DAYS, TrustReleaseRequest } from "@dishdesk/shared";
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
import { createCardUpdateSession, createCheckoutSession, hasSubscription } from "./stripe.js";

/**
 * Pagamento da assinatura: na tela de bloqueio (teste encerrado ou assinatura vencida) e na aba Pagamento das
 * configurações. Quem está bloqueado ainda não tem access token, porque o restaurante bloqueado não recebe um: as
 * rotas valem pelo cookie de sessão e por isso ficam dentro de /auth, o único caminho para onde o navegador manda o
 * cookie.
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
    if (!tenant.billing) throw new ConflictException("Este restaurante não tem cobrança pelo sistema.");
    // Em dia: no teste ou com o período pago em vigor. Fora disso (bloqueado ou liberado por confiança) a cobrança é na hora.
    const upToDate = !tenant.blockedBy && !tenant.billing.trustUntil;
    if (body.plan === "monthly" && upToDate && tenant.billing.plan === "ANNUAL") {
      throw new ConflictException("O plano anual ainda está em vigor. O mensal fica disponível quando ele vencer.");
    }

    const { taxId, stripeCustomerId } = await this.db.withTenants({ tenantIds: [], userId: user.id }, (tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { taxId: true, stripeCustomerId: true } }),
    );
    // Bloqueado volta para a tela de pagamento; quem paga de dentro do painel volta para a aba Pagamento.
    const page = new URL(tenant.blockedBy ? "/assinatura" : "/configuracoes/pagamento", this.env.WEB_ORIGIN);
    if (tenant.blockedBy) page.searchParams.set("restaurante", tenant.id);
    const flagged = (flag: string) => {
      const url = new URL(page);
      url.searchParams.set(flag, "1");
      return url.toString();
    };
    try {
      // Quem já assina o mensal e está em dia só troca o cartão: outra assinatura cobraria em dobro.
      if (body.plan === "monthly" && upToDate && stripeCustomerId && (await hasSubscription(this.env, stripeCustomerId))) {
        return { url: await createCardUpdateSession(this.env, { customerId: stripeCustomerId, returnUrl: page.toString(), doneUrl: flagged("cartao") }) };
      }
      const url = await createCheckoutSession(this.env, {
        plan: body.plan,
        tenantId: tenant.id,
        tenantName: tenant.name,
        taxId,
        customerId: stripeCustomerId,
        email: user.email,
        successUrl: flagged("pago"),
        cancelUrl: page.toString(),
      });
      return { url };
    } catch (error) {
      this.logger.error(error);
      throw new BadGatewayException("Não foi possível abrir o pagamento. Tente de novo em instantes.");
    }
  }

  /** "Liberar acesso por confiança": assinatura vencida, uma vez por atraso. Qualquer usuário do restaurante libera. */
  @Public()
  @Post("trust")
  @HttpCode(204)
  async trust(@Body(new ZodPipe(TrustReleaseRequest)) body: TrustReleaseRequest, @Req() request: Request): Promise<void> {
    const { user, tenants } = await this.auth.sessionProfile(sessionCookie(request));
    if (!tenants.some((t) => t.id === body.tenantId)) throw new ForbiddenException("Sem acesso a este restaurante.");
    const [result] = await this.db.withTenants({ tenantIds: [], userId: user.id }, (tx) =>
      tx.$queryRaw<{ released: boolean }[]>`SELECT app.release_tenant_trust(${body.tenantId}::uuid, ${TRUST_DAYS}::int) AS released`,
    );
    if (!result?.released) throw new ConflictException("A liberação por confiança não está disponível para este restaurante.");
  }
}
