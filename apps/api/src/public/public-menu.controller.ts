import { BadRequestException, Body, Controller, Get, Header, HttpCode, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { z } from "zod";
import { Public } from "../auth/auth.decorators.js";
import { ENV, type Env } from "../config/env.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { CustomerAuthService, SESSION_COOKIE, SESSION_TTL_MS } from "./customer-auth.service.js";
import { PublicMenuService } from "./public-menu.service.js";
import { withClientInfo } from "../funnel/meta-capi.js";
import { PublicOrderService } from "./public-order.service.js";
import { clientIp, PublicThrottlerGuard } from "./public-throttler.guard.js";

/** Pedidos por IP por minuto em cada rota pública. */
export const PUBLIC_RATE_LIMIT = 120;

const Slug = z.string().trim().min(1).max(120);

export const PriceRequest = z.object({
  itemId: z.uuid(),
  sizeId: z.uuid().nullish(),
  optionIds: z.array(z.uuid()).max(50).optional(),
  halves: z.array(z.uuid()).max(2).optional(),
  quantity: z.number().int(),
});

export const DeliveryQuoteRequest = z.object({
  mode: z.enum(["DELIVERY", "PICKUP"]),
  subtotalCents: z.number().int().min(0).max(100_000_000),
  address: z
    .object({
      district: z.string().trim().max(80).nullish(),
      lat: z.number().min(-90).max(90).nullish(),
      lng: z.number().min(-180).max(180).nullish(),
    })
    .optional(),
});

export const RateOrderRequest = z.object({ score: z.number().int().min(1).max(5) });
export const OtpRequest = z.object({ phone: z.string().trim().min(8).max(30) });
export const OtpVerify = z.object({
  phone: z.string().trim().min(8).max(30),
  code: z.string().trim().regex(/^\d{6}$/),
  name: z.string().trim().max(120).nullish(),
  marketingOptIn: z.boolean().optional(),
});

const Text = (max: number) => z.string().trim().max(max);

const AttrText = z.string().trim().min(1).max(300).optional();
/** Origem da visita (F7-02): só estas chaves entram; o resto é descartado. */
export const AttributionSchema = z.object({
  utm_source: AttrText,
  utm_medium: AttrText,
  utm_campaign: AttrText,
  utm_content: AttrText,
  utm_term: AttrText,
  fbclid: AttrText,
  fbc: AttrText,
  fbp: AttrText,
  referrer: AttrText,
  /** Escolha do visitante sobre a medição de anúncios (F7-03, LGPD): fica registrada em cada evento. */
  ads_consent: z.enum(["granted", "denied", "unset"]).optional(),
});

/** Envio do pedido (F3-08): só as escolhas; preço, taxa e horário o servidor confere de novo. */
export const PlaceOrderRequest = z.object({
  idempotencyKey: z.uuid(),
  lines: z
    .array(
      PriceRequest.extend({
        lineId: z.string().min(1).max(64),
        note: Text(140).nullish(),
        /** Total da linha que o cliente viu: diferente do de agora, PRICE_CHANGED. */
        expectedTotalCents: z.number().int().min(0).max(100_000_000).optional(),
      }),
    )
    .min(1)
    .max(50),
  fulfillment: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("DELIVERY"),
      savedAddressId: z.uuid().nullish(),
      address: z
        .object({
          street: Text(120).min(1),
          number: Text(20),
          complement: Text(80).nullish(),
          district: Text(80).min(1),
          city: Text(80).min(1),
          state: Text(2),
          zipCode: Text(9).nullish(),
          reference: Text(120).nullish(),
        })
        .nullish(),
      lat: z.number().min(-90).max(90).nullish(),
      lng: z.number().min(-180).max(180).nullish(),
      saveAs: z.enum(["Casa", "Trabalho"]).nullish(),
    }),
    z.object({ mode: z.literal("PICKUP") }),
  ]),
  when: z.discriminatedUnion("kind", [z.object({ kind: z.literal("now") }), z.object({ kind: z.literal("scheduled"), start: z.iso.datetime() })]),
  payment: z.object({
    method: z.enum(["pix", "cash", "credit", "debit", "pix_on_delivery"]),
    changeForCents: z.number().int().positive().max(100_000_000).nullish(),
    /** CPF do pagador, exigido pela Pagar.me no Pix (não fica guardado). */
    cpf: z.string().trim().max(20).nullish(),
  }),
  customer: z.object({ name: Text(120), phone: z.string().trim().min(8).max(30) }).nullish(),
  notes: Text(300).nullish(),
  marketingOptIn: z.boolean().optional(),
  /** Sessão anônima do navegador e origem da 1ª visita (F7-02): ligam o pedido ao funil. */
  sessionId: z.string().trim().min(8).max(64).optional(),
  attribution: AttributionSchema.optional(),
  /** Cupom da tag escolhido pelo cliente (só com a sessão do código). */
  couponId: z.string().trim().min(1).max(40).nullish(),
  /** Link com contexto do WhatsApp (F3-11). */
  contextToken: z.string().trim().max(200).nullish(),
});

/** Sessão do cliente: cookie httpOnly (o painel do cardápio) ou `Authorization: Bearer`. */
function sessionToken(request: Request): string | undefined {
  const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
  return bearer ?? (request.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
}

/** Cache curto só no que não depende de quem pede: o cardápio muda (esgotado, horário) e precisa aparecer logo. */
const SHORT_CACHE = "public, max-age=30";

/** Cardápio público (`/api/public/menu/:slug/...`): sem login, com limite por IP. */
@Public()
@UseGuards(PublicThrottlerGuard)
@Throttle({ default: { limit: PUBLIC_RATE_LIMIT, ttl: 60_000 } })
@Controller("public/menu/:slug")
export class PublicMenuController {
  constructor(
    private readonly menu: PublicMenuService,
    private readonly customers: CustomerAuthService,
    private readonly orders: PublicOrderService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  @Header("Cache-Control", SHORT_CACHE)
  get(@Param("slug", new ZodPipe(Slug)) slug: string) {
    return this.menu.menu(slug);
  }

  @Get("items/:id")
  @Header("Cache-Control", SHORT_CACHE)
  item(@Param("slug", new ZodPipe(Slug)) slug: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.menu.item(slug, id);
  }

  @Post("price")
  @HttpCode(200)
  price(@Param("slug", new ZodPipe(Slug)) slug: string, @Body(new ZodPipe(PriceRequest)) body: z.output<typeof PriceRequest>) {
    return this.menu.price(slug, body);
  }

  @Post("delivery-quote")
  @HttpCode(200)
  quote(@Param("slug", new ZodPipe(Slug)) slug: string, @Body(new ZodPipe(DeliveryQuoteRequest)) body: z.output<typeof DeliveryQuoteRequest>) {
    return this.menu.deliveryQuote(slug, body);
  }

  @Get("slots")
  @Header("Cache-Control", SHORT_CACHE)
  slots(@Param("slug", new ZodPipe(Slug)) slug: string) {
    return this.menu.slots(slug);
  }

  /** Código de entrada pelo WhatsApp do restaurante (F3-05). A resposta não diz se o telefone já é cliente. */
  @Post("otp/request")
  @HttpCode(200)
  otpRequest(@Param("slug", new ZodPipe(Slug)) slug: string, @Body(new ZodPipe(OtpRequest)) body: z.output<typeof OtpRequest>, @Req() request: Request) {
    return this.customers.requestCode(slug, body.phone, clientIp(request));
  }

  @Post("otp/verify")
  @HttpCode(200)
  async otpVerify(
    @Param("slug", new ZodPipe(Slug)) slug: string,
    @Body(new ZodPipe(OtpVerify)) body: z.output<typeof OtpVerify>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const token = await this.customers.verifyCode(slug, body);
    response.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.env.NODE_ENV === "production",
      path: `/api/public/menu/${slug}`,
      maxAge: SESSION_TTL_MS,
    });
    return { ok: true };
  }

  @Get("me")
  @Header("Cache-Control", "no-store")
  me(@Param("slug", new ZodPipe(Slug)) slug: string, @Req() request: Request) {
    return this.customers.me(slug, sessionToken(request));
  }

  /** Fazer pedido (F3-08, F6-07). Repetir com a mesma `idempotencyKey` devolve o mesmo pedido. */
  @Post("orders")
  @HttpCode(200)
  placeOrder(@Param("slug", new ZodPipe(Slug)) slug: string, @Body(new ZodPipe(PlaceOrderRequest)) body: z.output<typeof PlaceOrderRequest>, @Req() request: Request) {
    const attribution = body.attribution ? withClientInfo(Object.fromEntries(Object.entries(body.attribution).filter(([, v]) => typeof v === "string")) as Record<string, string>, request) : undefined;
    return this.orders.place(slug, { ...body, attribution }, sessionToken(request));
  }

  /** Confirmação do pedido (W15): com a sessão do mesmo cliente ou o token devolvido na criação (`X-Order-Token`). */
  @Get("orders/:id")
  @Header("Cache-Control", "no-store")
  order(@Param("slug", new ZodPipe(Slug)) slug: string, @Param("id", ParseUUIDPipe) id: string, @Req() request: Request) {
    const orderToken = request.headers["x-order-token"];
    return this.orders.get(slug, id, { sessionToken: sessionToken(request), orderToken: typeof orderToken === "string" ? orderToken : undefined });
  }

  /** Pedidos do cliente identificado pelo código (W16), 10 por página: `?before=<data do último>`. */
  @Get("me/orders")
  @Header("Cache-Control", "no-store")
  myOrders(@Param("slug", new ZodPipe(Slug)) slug: string, @Query("before") before: string | undefined, @Req() request: Request) {
    const date = before ? new Date(before) : undefined;
    if (date && Number.isNaN(date.getTime())) throw new BadRequestException("Data inválida.");
    return this.customers.orders(slug, sessionToken(request), date);
  }

  /** Cupons e vantagens do cliente identificado pelo código; `?subtotal=` marca os que não alcançam o mínimo. */
  @Get("me/coupons")
  @Header("Cache-Control", "no-store")
  myCoupons(@Param("slug", new ZodPipe(Slug)) slug: string, @Query("subtotal") subtotal: string | undefined, @Req() request: Request) {
    const cents = subtotal != null && /^\d{1,9}$/.test(subtotal) ? Number(subtotal) : undefined;
    return this.customers.coupons(slug, sessionToken(request), cents);
  }

  /** Link com contexto (F3-11): as escolhas do carrinho da conversa do WhatsApp, para a sacola do site. */
  @Get("context")
  @Header("Cache-Control", "no-store")
  context(@Param("slug", new ZodPipe(Slug)) slug: string, @Query("c") token: string | undefined) {
    if (!token || token.length > 200) throw new NotFoundException("Este link venceu ou o pedido já foi feito.");
    return this.orders.context(slug, token);
  }

  /** Situação do Pix (W14): pago cria o pedido e devolve o acesso a ele. Acesso pelo `X-Payment-Token`. */
  @Get("payments/:id")
  @Header("Cache-Control", "no-store")
  payment(@Param("slug", new ZodPipe(Slug)) slug: string, @Param("id", ParseUUIDPipe) id: string, @Req() request: Request) {
    const token = request.headers["x-payment-token"];
    return this.orders.payment(slug, id, typeof token === "string" ? token : undefined);
  }

  /** Nota de 1 a 5 ao pedido entregue (W15), uma vez só. */
  @Post("orders/:id/rating")
  @HttpCode(200)
  rate(
    @Param("slug", new ZodPipe(Slug)) slug: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodPipe(RateOrderRequest)) body: z.output<typeof RateOrderRequest>,
    @Req() request: Request,
  ) {
    const orderToken = request.headers["x-order-token"];
    return this.orders.rate(slug, id, { sessionToken: sessionToken(request), orderToken: typeof orderToken === "string" ? orderToken : undefined }, body.score);
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Param("slug", new ZodPipe(Slug)) slug: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.customers.logout(sessionToken(request));
    response.clearCookie(SESSION_COOKIE, { path: `/api/public/menu/${slug}` });
  }
}
