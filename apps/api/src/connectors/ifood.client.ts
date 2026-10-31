import type { OrderStatus } from "@dishdesk/database/enums";
import { z } from "zod";
import type { Env } from "../config/env.js";

// Merchant API do iFood: autenticação, polling de eventos, detalhes do pedido, confirmação (ack), as etapas que a loja informa e as avaliações.

export const IfoodEvent = z.looseObject({
  id: z.string(),
  fullCode: z.string(),
  orderId: z.string(),
  merchantId: z.string(),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type IfoodEvent = z.infer<typeof IfoodEvent>;

const Money = z.coerce.number();
/** Complemento de um item, ou personalização de um complemento. */
const Choice = { name: z.string(), quantity: z.coerce.number().default(1) };

export const IfoodOrder = z.looseObject({
  id: z.string(),
  displayId: z.string().optional(),
  createdAt: z.string(),
  customer: z.looseObject({
    id: z.string(),
    name: z.string().optional(),
    documentNumber: z.string().optional(),
  }),
  // unitPrice é o preço base; totalPrice é o da linha, com os complementos (options) e as personalizações deles.
  items: z
    .array(
      z.looseObject({
        name: z.string(),
        quantity: z.coerce.number(),
        unitPrice: Money,
        totalPrice: Money.nullish(),
        observations: z.string().nullish(),
        options: z.array(z.looseObject({ ...Choice, customizations: z.array(z.looseObject(Choice)).nullish() })).nullish(),
      }),
    )
    .default([]),
  total: z.looseObject({ subTotal: Money, deliveryFee: Money.default(0), orderAmount: Money }),
  delivery: z
    .looseObject({
      deliveryAddress: z
        .looseObject({
          streetName: z.string(),
          streetNumber: z.string().optional(),
          complement: z.string().optional(),
          neighborhood: z.string().optional(),
          city: z.string(),
          state: z.string(),
          postalCode: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type IfoodOrder = z.infer<typeof IfoodOrder>;

/** A API responde uma lista com `cancelCodeId`; a documentação nova fala em `{ reasons: [{ code }] }`. Aceita as duas. */
const CancellationReason = z
  .looseObject({ cancelCodeId: z.string().optional(), code: z.string().optional(), description: z.string() })
  .transform((reason) => ({ code: reason.cancelCodeId ?? reason.code ?? "", description: reason.description }));
const CancellationReasons = z
  .union([z.array(CancellationReason), z.looseObject({ reasons: z.array(CancellationReason) }).transform((body) => body.reasons)])
  .transform((reasons) => reasons.filter((reason) => reason.code));
export type IfoodCancellationReason = { code: string; description: string };

/**
 * Eventos (fullCode) que mudam o status do pedido no Dish Desk; todos os eventos entram na linha do tempo (order_events).
 * COLLECTED: o entregador do iFood coletou (a saída real). DELIVERED: entregue na retirada/autoatendimento.
 * DELIVERY_DROP_CODE_VALIDATION_SUCCESS: o cliente deu o código ao entregador (a entrega real, na entrega própria).
 */
export const IFOOD_STATUS: Record<string, OrderStatus> = {
  PLACED: "PLACED",
  CONFIRMED: "CONFIRMED",
  PREPARATION_STARTED: "PREPARING",
  READY_TO_PICKUP: "READY",
  DISPATCHED: "DISPATCHED",
  COLLECTED: "DISPATCHED",
  DELIVERED: "DELIVERED",
  DELIVERY_DROP_CODE_VALIDATION_SUCCESS: "DELIVERED",
  CONCLUDED: "DELIVERED",
  CANCELLED: "CANCELED",
};

/** Avaliação da Review API (v2). Os campos variam entre a lista e o detalhe: quase tudo é opcional. */
export const IfoodReview = z.looseObject({
  id: z.string(),
  status: z.string().nullish(),
  visibility: z.string().nullish(),
  score: z.coerce.number(),
  comment: z.string().nullish(),
  customerName: z.string().nullish(),
  createdAt: z.string(),
  replies: z.array(z.looseObject({ text: z.string(), from: z.string().nullish(), createdAt: z.string().nullish() })).nullish(),
  order: z.looseObject({ id: z.string().nullish(), shortId: z.string().nullish() }).nullish(),
  questions: z.array(z.looseObject({ title: z.string().nullish(), answers: z.array(z.looseObject({ title: z.string() })).nullish() })).nullish(),
});
export type IfoodReview = z.infer<typeof IfoodReview>;
const ReviewPage = z.looseObject({ pageCount: z.coerce.number().nullish(), reviews: z.array(IfoodReview).default([]) });
/** Nota da loja: `score` é a média das avaliações válidas (últimos 3 meses, públicas). */
const ReviewSummary = z.looseObject({
  score: z.coerce.number().nullish(),
  totalReviewsCount: z.coerce.number().default(0),
  validReviewsCount: z.coerce.number().default(0),
});
export type IfoodReviewSummary = z.infer<typeof ReviewSummary>;
/** Páginas de 50 (o máximo do iFood): até 500 avaliações por loja e consulta. */
const REVIEW_PAGES = 10;

/** Resposta de erro da Merchant API, com o status HTTP (403: a loja não autoriza este aplicativo). */
export class IfoodError extends Error {
  constructor(
    path: string,
    readonly status: number,
  ) {
    super(`iFood ${path}: HTTP ${status}`);
  }
}

/** Código de vinculação do aplicativo distribuído: o responsável pela loja o confirma no Portal do Parceiro. */
const UserCode = z.object({
  userCode: z.string(),
  authorizationCodeVerifier: z.string(),
  verificationUrlComplete: z.string(),
  expiresIn: z.coerce.number(),
});
export type IfoodUserCode = z.infer<typeof UserCode>;

/** Acesso de uma loja no aplicativo distribuído (guardado cifrado no canal). */
export type IfoodGrant = { accessToken: string; refreshToken: string; expiresAt: string };

/** Loja que o token enxerga (`GET /merchant/v1.0/merchants`). */
const Merchant = z.looseObject({ id: z.string(), name: z.string().optional() });
export type IfoodMerchant = z.infer<typeof Merchant>;

export class IfoodClient {
  private token: { value: string; issuedAt: number; expiresAt: number } | null = null;

  /**
   * `bearer`: token de uma loja (aplicativo distribuído). Sem ele, vale a credencial da plataforma (client credentials,
   * aplicativo centralizado).
   */
  constructor(
    private readonly env: Pick<Env, "IFOOD_API_URL" | "IFOOD_CLIENT_ID" | "IFOOD_CLIENT_SECRET">,
    private readonly bearer?: () => Promise<string>,
  ) {}

  get configured(): boolean {
    return Boolean(this.env.IFOOD_CLIENT_ID && this.env.IFOOD_CLIENT_SECRET);
  }

  /** Eventos ainda não confirmados das lojas informadas (o iFood guarda até a confirmação). */
  async poll(merchantIds: string[]): Promise<IfoodEvent[]> {
    const response = await this.call("/order/v1.0/events:polling", { headers: { "x-polling-merchants": merchantIds.join(",") } });
    if (response.status === 204) return [];
    return z.array(IfoodEvent).parse(await response.json());
  }

  /**
   * O token lista as lojas que autorizavam o aplicativo quando foi emitido: loja aprovada depois só entra num token
   * novo. Descarta o token guardado, a não ser que tenha menos de 1 minuto (para não pedir outro a cada consulta), e
   * diz se descartou.
   */
  forgetToken(): boolean {
    if (!this.token || Date.now() - this.token.issuedAt < 60_000) return false;
    this.token = null;
    return true;
  }

  /** A loja autoriza este aplicativo? O iFood responde 403 à consulta de eventos de uma loja que não o autorizou. */
  async authorizes(merchantId: string): Promise<boolean> {
    this.forgetToken(); // a loja pode ter aprovado o acesso depois do token guardado
    try {
      await this.poll([merchantId]); // sem confirmar: os eventos continuam na fila para o polling
      return true;
    } catch (error) {
      if (error instanceof IfoodError && error.status === 403) return false;
      throw error;
    }
  }

  /** Lojas que este token enxerga (exige o módulo Merchant). No distribuído, as que o responsável autorizou. */
  async merchants(): Promise<IfoodMerchant[]> {
    const response = await this.call("/merchant/v1.0/merchants");
    return z.array(Merchant).parse(await response.json());
  }

  async order(orderId: string): Promise<IfoodOrder> {
    const response = await this.call(`/order/v1.0/orders/${orderId}`);
    return IfoodOrder.parse(await response.json());
  }

  /** Só eventos processados com sucesso são confirmados (os demais voltam no próximo polling). */
  async acknowledge(eventIds: string[]): Promise<void> {
    if (!eventIds.length) return;
    await this.call("/order/v1.0/events/acknowledgment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(eventIds.map((id) => ({ id }))),
    });
  }

  /** Etapa informada pela loja. O iFood só aceita o pedido (202): o status muda quando o evento chega pelo polling. */
  async advance(orderId: string, step: "confirm" | "readyToPickup" | "dispatch"): Promise<void> {
    await this.call(`/order/v1.0/orders/${orderId}/${step}`, { method: "POST" });
  }

  /** Motivos que o iFood aceita para cancelar o pedido agora (vazio: não dá para cancelar). */
  async cancellationReasons(orderId: string): Promise<IfoodCancellationReason[]> {
    const response = await this.call(`/order/v1.0/orders/${orderId}/cancellationReasons`);
    if (response.status === 204) return [];
    return CancellationReasons.parse(await response.json());
  }

  async requestCancellation(orderId: string, reason: IfoodCancellationReason): Promise<void> {
    await this.call(`/order/v1.0/orders/${orderId}/requestCancellation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason.description, cancellationCode: reason.code }),
    });
  }

  /** Plataforma de Negociação: resposta da loja ao pedido do cliente (ex.: cancelamento). Uma resposta por negociação. */
  async answerDispute(disputeId: string, answer: "accept" | "reject", reason?: string): Promise<void> {
    await this.call(`/order/v1.0/disputes/${disputeId}/${answer}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reason ? { reason } : {}),
    });
  }

  /** Avaliações da loja feitas a partir de `from`, das mais recentes às mais antigas como o iFood devolve. */
  async reviews(merchantId: string, from: Date, to: Date): Promise<IfoodReview[]> {
    const reviews: IfoodReview[] = [];
    for (let page = 1; page <= REVIEW_PAGES; page++) {
      const query = new URLSearchParams({ page: String(page), pageSize: "50", addCount: "true", dateFrom: from.toISOString(), dateTo: to.toISOString() });
      const response = await this.call(`/review/v2.0/merchants/${merchantId}/reviews?${query.toString()}`);
      if (response.status === 204) break;
      const body = ReviewPage.parse(await response.json());
      reviews.push(...body.reviews);
      if (body.reviews.length < 50 || page >= (body.pageCount ?? page)) break;
    }
    return reviews;
  }

  async reviewSummary(merchantId: string): Promise<IfoodReviewSummary> {
    const response = await this.call(`/review/v2.0/merchants/${merchantId}/summary`);
    return ReviewSummary.parse(await response.json());
  }

  /** Resposta da loja (10 a 300 caracteres). 409/422: a avaliação não aceita mais resposta; 422 também é texto recusado. */
  async answerReview(merchantId: string, reviewId: string, text: string): Promise<void> {
    await this.call(`/review/v2.0/merchants/${encodeURIComponent(merchantId)}/reviews/${encodeURIComponent(reviewId)}/answers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  private async call(path: string, init:Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}): Promise<Response> {
    const response = await fetch(`${this.env.IFOOD_API_URL}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${await (this.bearer ?? (() => this.accessToken()))()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) this.token = null; // renova na próxima chamada
    if (!response.ok) throw new IfoodError(path, response.status);
    return response;
  }

  /** OAuth client credentials, reaproveitado até 1 min antes de expirar. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const response = await fetch(`${this.env.IFOOD_API_URL}/authentication/v1.0/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grantType: "client_credentials",
        clientId: this.env.IFOOD_CLIENT_ID ?? "",
        clientSecret: this.env.IFOOD_CLIENT_SECRET ?? "",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`iFood autenticação: HTTP ${response.status}`);
    const body = z.object({ accessToken: z.string(), expiresIn: z.coerce.number() }).parse(await response.json());
    this.token = { value: body.accessToken, issuedAt: Date.now(), expiresAt: Date.now() + body.expiresIn * 1000 };
    return body.accessToken;
  }

  /** Aplicativo distribuído: código para o responsável pela loja autorizar o Dish Desk (vale `expiresIn` segundos). */
  async userCode(): Promise<IfoodUserCode> {
    const response = await this.authRequest("userCode", { clientId: this.env.IFOOD_CLIENT_ID ?? "" });
    return UserCode.parse(await response.json());
  }

  /**
   * Aplicativo distribuído: troca o código de autorização (que o Portal do Parceiro mostra depois de "Autorizar") pelo
   * acesso da loja, ou renova um acesso com o refreshToken.
   */
  async grant(from: { authorizationCode: string; verifier: string } | { refreshToken: string }): Promise<IfoodGrant> {
    const params: Record<string, string> =
      "refreshToken" in from
        ? { grantType: "refresh_token", refreshToken: from.refreshToken }
        : { grantType: "authorization_code", authorizationCode: from.authorizationCode, authorizationCodeVerifier: from.verifier };
    const response = await this.authRequest("token", {
      ...params,
      clientId: this.env.IFOOD_CLIENT_ID ?? "",
      clientSecret: this.env.IFOOD_CLIENT_SECRET ?? "",
    });
    const body = z
      .object({ accessToken: z.string(), refreshToken: z.string().optional(), expiresIn: z.coerce.number() })
      .parse(await response.json());
    const refreshToken = body.refreshToken ?? ("refreshToken" in from ? from.refreshToken : "");
    return { accessToken: body.accessToken, refreshToken, expiresAt: new Date(Date.now() + body.expiresIn * 1000).toISOString() };
  }

  private async authRequest(endpoint: "userCode" | "token", params: Record<string, string>): Promise<Response> {
    const path = `/authentication/v1.0/oauth/${endpoint}`;
    const response = await fetch(`${this.env.IFOOD_API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new IfoodError(path, response.status);
    return response;
  }
}
