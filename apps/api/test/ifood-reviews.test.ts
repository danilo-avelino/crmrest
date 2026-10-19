import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUES } from "../src/queues/queues.module.js";
import { accessTokenFor, admin, createChannelFixture, createTestApp } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;

/** Review API falsa: avaliações por loja (páginas de até 50), nota e respostas. */
async function startMockReviews() {
  const state = {
    reviews: new Map<string, object[]>(),
    queries: [] as string[],
    answers: [] as { merchantId: string; reviewId: string; text: string }[],
    forbidden: new Set<string>(),
    answerStatus: 201,
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const url = new URL(req.url ?? "", "http://ifood");
    const json = (status: number, body?: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(body === undefined ? undefined : JSON.stringify(body));

    if (url.pathname === "/authentication/v1.0/oauth/token") return json(200, { accessToken: "token-ifood", type: "bearer", expiresIn: 21600 });
    if (req.headers.authorization !== "Bearer token-ifood") return json(401);
    if (url.pathname === "/order/v1.0/events:polling") return json(204);
    const route = url.pathname.match(/^\/review\/v2\.0\/merchants\/([^/]+)\/(reviews|summary)(?:\/([^/]+)\/answers)?$/);
    if (!route) return json(404);
    const [, merchantId = "", kind, reviewId] = route;
    if (state.forbidden.has(merchantId)) return json(403);
    const all = state.reviews.get(merchantId) ?? [];
    if (kind === "summary") return json(200, { totalReviewsCount: all.length + 10, validReviewsCount: all.length, score: 4.4 });
    if (reviewId) {
      state.answers.push({ merchantId, reviewId, ...(JSON.parse(raw) as { text: string }) });
      return json(state.answerStatus, state.answerStatus === 201 ? { reviewId, text: "ok", createdAt: new Date().toISOString() } : undefined);
    }
    state.queries.push(url.search);
    const from = Date.parse(url.searchParams.get("dateFrom") ?? "");
    const inPeriod = all.filter((review) => Date.parse((review as { createdAt: string }).createdAt) >= from);
    const page = Number(url.searchParams.get("page"));
    const size = Number(url.searchParams.get("pageSize"));
    return json(200, {
      page,
      size,
      total: inPeriod.length,
      pageCount: Math.ceil(inPeriod.length / size),
      reviews: inPeriod.slice((page - 1) * size, page * size),
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const review = (id: string, score: number, daysAgo: number, extra: object = {}) => ({
  id,
  score,
  status: "PUBLISHED",
  visibility: "PUBLIC",
  version: "v2",
  createdAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
  replies: [],
  ...extra,
});

describe("aba Avaliações → iFood: avaliações das lojas e a resposta da loja", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let ifood: Awaited<ReturnType<typeof startMockReviews>>;
  let token: string;

  beforeAll(async () => {
    ifood = await startMockReviews();
    app = await createTestApp({ IFOOD_CLIENT_ID: "cliente", IFOOD_CLIENT_SECRET: "segredo", IFOOD_API_URL: ifood.url });
    await app.get<Queue>(getQueueToken(QUEUES.ifood)).removeJobScheduler("ifood-polling");
    fx = await createChannelFixture();
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await ifood?.close();
  });

  const list = (period = "30d") =>
    request(app.getHttpServer()).get(`/api/reports/ifood-reviews?tenantId=${fx.tenant.id}&period=${period}`).set("Authorization", `Bearer ${token}`);
  const answer = (reviewId: string, text: string, storeId = fx.ifood.id) =>
    request(app.getHttpServer())
      .post(`/api/reports/ifood-reviews/${storeId}/${reviewId}/answer?tenantId=${fx.tenant.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text });

  it("atendente não vê as avaliações", async () => {
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    await list().expect(403);
  });

  it("administrador: avaliações do período, mais recentes primeiro, com a nota da loja e o prazo para responder", async () => {
    await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role: "ADMIN" } });
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    ifood.state.reviews.set(fx.ifood.externalId, [
      review("r-antiga", 5, 40),
      review("r-negativa", 2, 1, {
        status: "NOT_REPLIED",
        comment: "  Chegou frio  ",
        customerName: "Carla",
        order: { id: "pedido-1", shortId: "4852" },
        questions: [{ title: "Do que você não gostou?", answers: [{ title: "Temperatura" }, { title: "Entrega" }] }],
      }),
      review("r-respondida", 3, 3, {
        status: "REPLIED",
        visibility: "PRIVATE",
        replies: [{ text: "Obrigado pelo retorno!", from: "MERCHANT", createdAt: new Date().toISOString() }],
      }),
    ]);

    const { body } = await list("30d").expect(200);
    expect(body.stores).toEqual([{ id: fx.ifood.id, name: "IFOOD", score: 4.4, validReviews: 3, totalReviews: 13 }]);
    expect(body.unavailable).toEqual([]);
    expect(body.reviews.map((r: { id: string }) => r.id)).toEqual(["r-negativa", "r-respondida"]);
    const [negative, replied] = body.reviews;
    expect(negative).toMatchObject({
      storeId: fx.ifood.id,
      score: 2,
      comment: "Chegou frio",
      customerName: "Carla",
      status: "NOT_REPLIED",
      orderCode: "4852",
      answers: ["Temperatura", "Entrega"],
      replies: [],
    });
    expect(Date.parse(negative.replyBy) - Date.parse(negative.createdAt)).toBe(5 * DAY);
    expect(replied).toMatchObject({ visibility: "PRIVATE", replyBy: null, replies: [{ text: "Obrigado pelo retorno!", from: "MERCHANT" }] });
    expect(ifood.state.queries.at(-1)).toContain("pageSize=50");

    expect((await list("90d").expect(200)).body.reviews).toHaveLength(3);
  });

  it("lê todas as páginas da loja", async () => {
    ifood.state.reviews.set(
      fx.ifood.externalId,
      Array.from({ length: 120 }, (_, i) => review(`r-${i}`, 4, 1)),
    );
    const { body } = await list("7d").expect(200);
    expect(body.reviews).toHaveLength(120);
  });

  it("loja sem acesso às avaliações (módulo não liberado): fica de fora, sem derrubar a consulta", async () => {
    ifood.state.forbidden.add(fx.ifood.externalId);
    const { body } = await list().expect(200);
    expect(body).toEqual({ stores: [], reviews: [], unavailable: [{ id: fx.ifood.id, name: "IFOOD", reason: "forbidden" }] });
    ifood.state.forbidden.delete(fx.ifood.externalId);
  });

  it("resposta da loja vai ao iFood; texto fora de 10–300 caracteres não sai do Dish Desk", async () => {
    await answer("r-negativa", "Curto").expect(400);
    await answer("r-negativa", "x".repeat(301)).expect(400);
    expect(ifood.state.answers).toEqual([]);

    await answer("r-negativa", "  Sentimos muito! Já ajustamos a embalagem.  ").expect(204);
    expect(ifood.state.answers).toEqual([{ merchantId: fx.ifood.externalId, reviewId: "r-negativa", text: "Sentimos muito! Já ajustamos a embalagem." }]);
  });

  it("recusa do iFood vira uma mensagem para a equipe", async () => {
    ifood.state.answerStatus = 409;
    const { body } = await answer("r-negativa", "Obrigado pelo seu retorno!").expect(422);
    expect(body.message).toContain("não aceita mais resposta");
    ifood.state.answerStatus = 201;
  });

  it("loja de outro restaurante não responde", async () => {
    await answer("r-negativa", "Obrigado pelo seu retorno!", randomUUID()).expect(404);
  });
});
