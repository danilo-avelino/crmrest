import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ContactDuplicateReviewService } from "../src/contacts/contact-duplicate-review.service.js";
import { findDuplicatePairs } from "../src/contacts/contact-duplicates.js";
import { DatabaseService } from "../src/core/database.service.js";
import { QUEUES } from "../src/queues/queues.module.js";
import { accessTokenFor, admin, createChannelFixture, createTestApp, startMockGraph } from "./helpers.js";

type Side = { nome: string | null };
type JevBody = { state: { cadastro_1: Side; cadastro_2: Side; mesmo_telefone: string; motivos: string[] } };

/** O que o Jev falso responde, pelo nome de um dos cadastros. Outro nome (de outro restaurante do banco): HTTP 500. */
const CHANCE: Record<string, number> = { "Joana Prado": 0.95, "Pedro Lima": 0.1, "Rafael Costa": 0.6, "Lucas Dias": 0.95 };

describe("possíveis duplicados revisados pelo Jev", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let jev: Awaited<ReturnType<typeof startMockGraph>>;
  let service: ContactDuplicateReviewService;
  let token: string;
  const ids: Record<string, string> = {};

  const queue = async () => {
    const { body } = await request(app.getHttpServer()).get("/api/contacts/duplicates").set({ Authorization: `Bearer ${token}` }).expect(200);
    return body.map((pair: { keep: { name: string }; other: { name: string }; reasons: string[] }) => [pair.keep.name, pair.other.name, pair.reasons]);
  };
  const unreviewed = () => app.get(DatabaseService).withTenants({ tenantIds: [fx.tenant.id] }, (tx) => findDuplicatePairs(tx, "unreviewed"));

  beforeAll(async () => {
    jev = await startMockGraph();
    jev.reply((req) => {
      const { cadastro_1, cadastro_2 } = (req.body as JevBody).state;
      const chance = CHANCE[cadastro_1.nome ?? ""] ?? CHANCE[cadastro_2.nome ?? ""];
      if (chance === undefined) return { status: 500, body: {} };
      return { status: 200, body: { model: "typesafe/jev-1.14-20261101", answers: { same: { type: "noul", noul: chance } }, usage: { input_tokens: 300, output_tokens: 2, cost: 0.00001 } } };
    });
    app = await createTestApp({ JEV_API_KEY: "chave-de-teste", JEV_URL: `${jev.url}/api/alpha/decisions` });
    await app.get<Queue>(getQueueToken(QUEUES.ai)).removeJobScheduler("duplicate-review-sweep");
    service = app.get(ContactDuplicateReviewService);
    fx = await createChannelFixture();
    await admin.tenantMember.update({ where: { tenantId_userId: { tenantId: fx.tenant.id, userId: fx.user.id } }, data: { role: "ADMIN" } });
    token = await accessTokenFor(app, fx.user.email, fx.tenant.id);

    const tenantId = fx.tenant.id;
    const old = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    const contact = async (key: string, data: object, address?: { street: string; number: string; complement: string }) => {
      const created = await admin.contact.create({
        data: { tenantId, ...data, ...(address && { addresses: { create: { tenantId, city: "São Paulo", state: "SP", ...address } } }) },
      });
      ids[key] = created.id;
    };
    // Mesmo telefone, mesma pessoa: o Jev une sozinho.
    await contact("joana", { name: "Joana Prado", phone: "+5511900000001", firstSeenAt: old });
    await contact("joanaIfood", { name: "Joana P.", phone: "+5511900000001" });
    // Mesmo telefone, pessoas diferentes (mãe e filho no mesmo WhatsApp): o Jev descarta.
    await contact("pedro", { name: "Pedro Lima", phone: "+5511900000002", firstSeenAt: old });
    await contact("marta", { name: "Marta Lima", phone: "+5511900000002" });
    // Só o endereço, e o Jev na dúvida: vai para o admin.
    await contact("rafael", { name: "Rafael Costa", firstSeenAt: old }, { street: "Rua Harmonia", number: "88", complement: "apto 12" });
    await contact("rafa", { name: "Rafa" }, { street: "rua harmonia ", number: "88", complement: "Apto. 12" });
    // Só o nome: mesmo com certeza do Jev, não é unido sem o admin.
    await contact("lucas", { name: "Lucas Dias", firstSeenAt: old });
    await contact("lucas2", { name: "Lucas Dias" });
    // Vizinhos (mesmo prédio, apartamentos diferentes): nem chegam a ser par.
    await contact("vizinho1", { name: "Bruno Alves" }, { street: "Rua Fradique Coutinho", number: "300", complement: "apto 21" });
    await contact("vizinho2", { name: "Carla Mendes" }, { street: "Rua Fradique Coutinho", number: "300", complement: "apto 22" });
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await jev?.close();
  });

  it("antes da revisão do Jev, nada chega ao admin; vizinhos do mesmo prédio nem são par", async () => {
    expect(await queue()).toEqual([]);
    const pairs = await unreviewed();
    expect(pairs).toHaveLength(4);
    expect(pairs.some((pair) => [pair.a, pair.b].includes(ids.vizinho1!))).toBe(false);
  });

  it("o Jev une os de mesmo telefone em que tem certeza, descarta os diferentes e manda o resto ao admin", async () => {
    await service.enqueue(fx.tenant.id);
    await vi.waitFor(
      async () => {
        expect(await admin.contact.findUnique({ where: { id: ids.joanaIfood! } })).toBeNull();
        expect(await admin.contactDuplicateReview.count({ where: { tenantId: fx.tenant.id } })).toBe(3);
      },
      { timeout: 15_000, interval: 200 },
    );

    expect(jev.requests).toHaveLength(4);
    // Vão os nomes e se o telefone é o mesmo, nunca o número.
    const sent = jev.requests.map((req) => (req.body as JevBody).state).find((state) => state.cadastro_1.nome?.startsWith("Joana"))!;
    expect(sent).toMatchObject({ mesmo_telefone: "sim", motivos: ["mesmo telefone"] });
    expect([sent.cadastro_1.nome, sent.cadastro_2.nome].toSorted((x, y) => (x ?? "").localeCompare(y ?? ""))).toEqual(["Joana P.", "Joana Prado"]);
    expect(JSON.stringify(jev.requests)).not.toContain("900000001");

    expect(await admin.auditLog.findFirst({ where: { entityId: ids.joana!, action: "contact.merged" } })).toMatchObject({
      userId: null,
      data: { mergedContactId: ids.joanaIfood, by: "jev", sameChance: 0.95 },
    });
    expect(await admin.contact.findUnique({ where: { id: ids.marta! } })).not.toBeNull(); // descartado, não unido
    expect(await admin.aiUsage.count({ where: { tenantId: fx.tenant.id, provider: "JEV" } })).toBe(4);

    expect(await queue()).toEqual(
      expect.arrayContaining([
        ["Rafael Costa", "Rafa", ["address"]],
        ["Lucas Dias", "Lucas Dias", ["name"]],
      ]),
    );
    expect(await queue()).toHaveLength(2);
    expect(await unreviewed()).toEqual([]);

    // A tela recebe a chance do Jev e o endereço que bateu, com o complemento.
    const { body } = await request(app.getHttpServer()).get("/api/contacts/duplicates").set({ Authorization: `Bearer ${token}` }).expect(200);
    const rafael = body.find((pair: { keep: { id: string } }) => pair.keep.id === ids.rafael);
    expect(rafael).toMatchObject({
      sameChance: 0.6,
      keep: { email: null, cpfMasked: null, addresses: [{ text: "Rua Harmonia, 88, apto 12 · São Paulo - SP", matches: true }] },
      other: { addresses: [{ text: "rua harmonia , 88, Apto. 12 · São Paulo - SP", matches: true }] },
    });
  });

  it("o par que passa a bater em outro dado é revisado de novo", async () => {
    await admin.contact.updateMany({ where: { id: { in: [ids.pedro!, ids.marta!] } }, data: { email: "familia.lima@exemplo.com" } });
    expect((await unreviewed()).map((pair) => pair.reasons)).toEqual([["email", "phone"]]);
  });
});
