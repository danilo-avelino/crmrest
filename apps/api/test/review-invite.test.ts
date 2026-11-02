import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REVIEW_INVITE_WAIT_MS, reviewInviteDecision, ReviewInviteService } from "../src/automations/review-invite.service.js";
import { QUEUES } from "../src/queues/queues.module.js";
import { accessTokenFor, admin, createChannelFixture, createTestApp } from "./helpers.js";

const CLOCK = new Intl.DateTimeFormat("pt-BR", { timeStyle: "medium", timeZone: "America/Sao_Paulo" });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const shown = (direction: "INBOUND" | "OUTBOUND", text: string, at: Date) => ({ direction, text, time: CLOCK.format(at) });
/** O pedido como o iFood manda: o horário prometido e o nome do cliente. */
const raw = (promised: Date | null, customer = "Carlos Mendes") => ({
  customer: { name: customer },
  ...(promised && { delivery: { deliveryDateTime: promised.toISOString() } }),
});
const TEXT = (code: string) => `Como foi o seu pedido #${code}? 😊 Se puder, deixe sua avaliação da loja aqui no app do iFood. Isso nos ajuda muito!`;

describe("regra do convite de avaliação", () => {
  const now = new Date("2026-11-02T20:30:00-03:00");
  const at = (clock: string) => new Date(`2026-11-02T${clock}:00-03:00`);
  const decide = (order: { status?: "DISPATCHED" | "DELIVERED" | "CANCELED" | "PREPARING"; deliveredAt?: string; promised?: string }) =>
    reviewInviteDecision(
      { status: order.status ?? "DELIVERED", deliveredAt: order.deliveredAt ? at(order.deliveredAt) : null, raw: raw(order.promised ? at(order.promised) : null) },
      now,
    );

  it("entregue no prazo: sai 10 minutos depois da entrega, e não antes", () => {
    expect(decide({ deliveredAt: "20:15", promised: "20:40" })).toEqual({ dueAt: at("20:25"), status: "PENDING" });
    expect(decide({ deliveredAt: "20:25", promised: "20:40" })).toBeNull();
  });

  it("entregue depois do prometido, ou cancelado: fica de fora", () => {
    expect(decide({ deliveredAt: "20:10", promised: "20:00" })).toMatchObject({ status: "SKIPPED", reason: "late" });
    expect(decide({ status: "CANCELED", promised: "20:00" })).toMatchObject({ status: "SKIPPED", reason: "canceled" });
  });

  it("sem aviso de entrega, conta do prometido: atraso desconhecido não tira o convite, mas pedido ainda na loja sim", () => {
    expect(decide({ status: "DISPATCHED", promised: "20:15" })).toEqual({ dueAt: at("20:25"), status: "PENDING" });
    expect(decide({ status: "DELIVERED", promised: "20:15" })).toMatchObject({ status: "PENDING" });
    expect(decide({ status: "PREPARING", promised: "20:15" })).toMatchObject({ status: "SKIPPED", reason: "not_delivered" });
  });

  it("sem horário nenhum não há convite; passou do prazo de espera, é descartado", () => {
    expect(decide({ status: "DISPATCHED" })).toBeNull();
    expect(decide({ deliveredAt: "19:30", promised: "20:00" })).toMatchObject({ status: "EXPIRED" });
  });
});

describe("Convite de avaliação no iFood (trava IFOOD_CHAT_BRIDGE ligada)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let token: string;
  let invites: ReviewInviteService;
  let code = 7100;
  const post = (path: string, body?: object) => request(app.getHttpServer()).post(`/api${path}`).set("Authorization", `Bearer ${token}`).send(body);
  const inviteOf = (orderId: string) => admin.reviewInvite.findUnique({ where: { orderId } });
  const conversations = (contactId: string) => admin.conversation.findMany({ where: { contactId } });
  const setEnabled = (enabled: boolean) => admin.tenant.update({ where: { id: fx.tenant.id }, data: { settings: { reviewInvite: { enabled } } } });

  /** Pedido entregue há 11 minutos, dentro do prometido (o padrão), em nome de um cliente novo. */
  const delivered = async (extra: { deliveredAt?: Date | null; status?: "DELIVERED" | "DISPATCHED" | "CANCELED"; placedAt?: Date; promised?: Date | null; customer?: string; contactId?: string } = {}) => {
    const displayCode = String(code++);
    const contactId =
      extra.contactId ??
      (await admin.contact.create({ data: { tenantId: fx.tenant.id, name: "Carlos", identities: { create: { tenantId: fx.tenant.id, channelType: "IFOOD", externalId: randomUUID() } } } })).id;
    const order = await admin.order.create({
      data: {
        tenantId: fx.tenant.id,
        contactId,
        channelId: fx.ifood.id,
        externalOrderId: randomUUID(),
        displayCode,
        status: extra.status ?? "DELIVERED",
        subtotal: 40,
        deliveryFee: 5,
        total: 45,
        placedAt: extra.placedAt ?? minutesAgo(50),
        deliveredAt: extra.deliveredAt === undefined ? minutesAgo(11) : extra.deliveredAt,
        raw: raw(extra.promised === undefined ? minutesAgo(-10) : extra.promised, extra.customer),
      },
      select: { id: true, contactId: true },
    });
    return { ...order, displayCode };
  };

  beforeAll(async () => {
    [app, fx] = await Promise.all([createTestApp({ IFOOD_WIDGET_ID: "widget-teste", IFOOD_CHAT_BRIDGE: "true" }), createChannelFixture()]);
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    invites = app.get(ReviewInviteService);
  });

  afterAll(async () => {
    for (const job of await app.get<Queue>(getQueueToken(QUEUES.outbound)).getDelayed()) await job.remove();
    await fx?.cleanup();
    await app?.close();
  });

  beforeEach(async () => {
    await admin.reviewInvite.deleteMany({ where: { tenantId: fx.tenant.id } });
    await admin.order.deleteMany({ where: { tenantId: fx.tenant.id } });
    await setEnabled(true);
  });

  it("desligado por padrão: o restaurante liga em Configurações; sem isso, nenhum convite", async () => {
    await admin.tenant.update({ where: { id: fx.tenant.id }, data: { settings: {} } });
    const order = await delivered();
    await invites.sweepTenant(fx.tenant.id);
    expect(await inviteOf(order.id)).toBeNull();

    const { body } = await request(app.getHttpServer()).get("/api/settings").set("Authorization", `Bearer ${token}`).expect(200);
    expect(body.find((item: { tenantId: string }) => item.tenantId === fx.tenant.id).reviewInvite).toEqual({ enabled: false });

    // Só o administrador do restaurante altera.
    const change = () => request(app.getHttpServer()).put(`/api/settings/${fx.tenant.id}/review-invite`).set("Authorization", `Bearer ${token}`).send({ enabled: true });
    await change().expect(403);
    await admin.tenantMember.updateMany({ where: { tenantId: fx.tenant.id, userId: fx.user.id }, data: { role: "ADMIN" } });
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    const { body: saved } = await change().expect(200);
    expect(saved.reviewInvite).toEqual({ enabled: true });

    await invites.sweepTenant(fx.tenant.id);
    expect(await inviteOf(order.id)).toMatchObject({ status: "PENDING", text: TEXT(order.displayCode) });
  });

  it("segue a personalidade do restaurante", async () => {
    await admin.tenant.update({ where: { id: fx.tenant.id }, data: { settings: { reviewInvite: { enabled: true }, personality: "direto" } } });
    const order = await delivered();
    await invites.sweepTenant(fx.tenant.id);
    expect((await inviteOf(order.id))!.text).toBe(`Avalie o pedido #${order.displayCode} no app do iFood. Sua avaliação nos ajuda.`);
  });

  it("registra por que ficou de fora; o pedido de antes de a loja ser conectada não entra", async () => {
    const late = await delivered({ placedAt: minutesAgo(20), promised: minutesAgo(15) });
    const canceled = await delivered({ placedAt: minutesAgo(20), status: "CANCELED", deliveredAt: null, promised: minutesAgo(15) });
    const untimed = await delivered({ placedAt: minutesAgo(20), status: "DISPATCHED", deliveredAt: null, promised: null });
    await admin.channel.update({ where: { id: fx.ifood.id }, data: { connectedAt: minutesAgo(30) } });
    const before = await delivered({ placedAt: minutesAgo(40) });
    try {
      await invites.sweepTenant(fx.tenant.id);
    } finally {
      await admin.channel.update({ where: { id: fx.ifood.id }, data: { connectedAt: null } });
    }
    expect(await inviteOf(late.id)).toMatchObject({ status: "SKIPPED", reason: "late", text: null });
    expect(await inviteOf(canceled.id)).toMatchObject({ status: "SKIPPED", reason: "canceled" });
    expect(await inviteOf(untimed.id)).toBeNull();
    expect(await inviteOf(before.id)).toBeNull();
  });

  it("vai para o chat do próprio pedido, com o nome do cliente; só um painel leva, e o envio não abre conversa nem agenda inatividade", async () => {
    const order = await delivered({ customer: "Paula Souza" });
    // O mesmo cliente fez outro pedido depois: o convite continua sendo o do primeiro.
    await delivered({ contactId: order.contactId, status: "DISPATCHED", deliveredAt: null, placedAt: minutesAgo(5), promised: minutesAgo(-30) });
    await invites.sweepTenant(fx.tenant.id);

    const { body: claimed } = await post("/ifood-chat/outbox/claim").expect(200);
    const invite = (await inviteOf(order.id))!;
    expect(claimed).toEqual([{ messageId: invite.id, orderCode: order.displayCode, text: TEXT(order.displayCode), customer: "Paula Souza" }]);
    expect((await post("/ifood-chat/outbox/claim").expect(200)).body).toEqual([]);

    await post(`/ifood-chat/outbox/${invite.id}`, { status: "SENT" }).expect(204);
    expect(await inviteOf(order.id)).toMatchObject({ status: "SENT", sentAt: expect.any(Date), reason: null });
    expect(await conversations(order.contactId)).toEqual([]);
    expect(await admin.message.count({ where: { tenantId: fx.tenant.id, content: { path: ["text"], equals: TEXT(order.displayCode) } } })).toBe(0);
    const delayed = await app.get<Queue>(getQueueToken(QUEUES.automations)).getJobs(["delayed"]);
    expect(delayed.some((job) => job.name === "inactivity" && job.data.tenantId === fx.tenant.id)).toBe(false);
  });

  it("a leitura do widget deixa o convite fora da Inbox; a resposta do cliente chama a equipe como numa conversa nova", async () => {
    const order = await delivered();
    await invites.sweepTenant(fx.tenant.id);
    const [{ messageId }] = (await post("/ifood-chat/outbox/claim").expect(200)).body;
    await post(`/ifood-chat/outbox/${messageId}`, { status: "SENT" }).expect(204);

    const bubble = shown("OUTBOUND", TEXT(order.displayCode), minutesAgo(2));
    expect((await post("/ifood-chat/sync", { orderCode: order.displayCode, messages: [bubble] }).expect(200)).body).toEqual({ found: true });
    expect(await conversations(order.contactId)).toEqual([]);

    // Resposta em menos de 5 minutos: não conta como conversa em andamento com a loja.
    await post("/ifood-chat/sync", { orderCode: order.displayCode, messages: [bubble, shown("INBOUND", "Chegou frio", minutesAgo(1))] }).expect(200);
    await vi.waitFor(async () => expect((await conversations(order.contactId))[0]?.awaitingAgentSince).not.toBeNull(), { timeout: 15_000, interval: 100 });
    const [chat] = await conversations(order.contactId);
    const texts = (await admin.message.findMany({ where: { conversationId: chat!.id }, orderBy: { createdAt: "asc" } })).map((m) => (m.content as { text?: string }).text);
    expect(texts).toContain("Chegou frio");
    expect(texts).not.toContain(TEXT(order.displayCode));
    await post("/ifood-chat/outbox/claim").expect(200);
  });

  it("sem painel dentro do prazo: descartado, e um painel que abre depois não envia", async () => {
    const order = await delivered();
    await invites.sweepTenant(fx.tenant.id);
    await invites.sweepTenant(fx.tenant.id, new Date(Date.now() + REVIEW_INVITE_WAIT_MS + 60_000));
    expect(await inviteOf(order.id)).toMatchObject({ status: "EXPIRED", sentAt: null });
    expect((await post("/ifood-chat/outbox/claim").expect(200)).body).toEqual([]);
  });

  it("pedido antigo quando o convite é ligado: descartado, sem convite atrasado", async () => {
    const order = await delivered({ deliveredAt: minutesAgo(200), placedAt: minutesAgo(250), promised: minutesAgo(190) });
    await invites.sweepTenant(fx.tenant.id);
    expect(await inviteOf(order.id)).toMatchObject({ status: "EXPIRED" });
  });

  it("desligar segura o que ainda não saiu", async () => {
    const order = await delivered();
    await invites.sweepTenant(fx.tenant.id);
    await setEnabled(false);
    await invites.sweepTenant(fx.tenant.id);
    expect(await inviteOf(order.id)).toMatchObject({ status: "EXPIRED" });
  });

  it("o que o painel conta da falha fica registrado; painel que some vira falha, e uma confirmação tardia ainda vale", async () => {
    const refused = await delivered();
    const silent = await delivered();
    await invites.sweepTenant(fx.tenant.id);
    const claimed = (await post("/ifood-chat/outbox/claim").expect(200)).body as { messageId: string; orderCode: string }[];
    const idOf = (code: string) => claimed.find((item) => item.orderCode === code)!.messageId;

    await post(`/ifood-chat/outbox/${idOf(refused.displayCode)}`, { status: "FAILED", error: "O chat deste pedido não está aberto no widget do iFood." }).expect(204);
    expect(await inviteOf(refused.id)).toMatchObject({ status: "FAILED", reason: "O chat deste pedido não está aberto no widget do iFood." });

    await invites.sweepTenant(fx.tenant.id, new Date(Date.now() + REVIEW_INVITE_WAIT_MS + 60_000));
    expect(await inviteOf(silent.id)).toMatchObject({ status: "FAILED", reason: "O painel não confirmou o envio." });
    await post(`/ifood-chat/outbox/${idOf(silent.displayCode)}`, { status: "SENT" }).expect(204);
    expect(await inviteOf(silent.id)).toMatchObject({ status: "SENT", reason: null });
  });
});
