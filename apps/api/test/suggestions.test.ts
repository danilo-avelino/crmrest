import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { accessTokenFor, admin, createAuthFixture, createTestApp, PASSWORD, startMockGraph } from "./helpers.js";

type LlmBody = { response_format: { json_schema: { name: string } }; messages: { role: string; content: string }[] };

describe("sugestões dos restaurantes", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let llm: Awaited<ReturnType<typeof startMockGraph>>;
  let superAdmin: { id: string; email: string };
  let token: string; // admin em B
  let superToken: string;
  // O assunto que a LLM falsa devolve; sem assunto, ela responde HTTP 500 (IA fora do ar).
  let subject: string | null = null;

  beforeAll(async () => {
    llm = await startMockGraph();
    llm.reply((req) => {
      if ((req.body as LlmBody).response_format.json_schema.name !== "assunto_sugestao" || !subject) return { status: 500, body: {} };
      return { status: 200, body: { choices: [{ message: { content: JSON.stringify({ subject }) } }] } };
    });
    app = await createTestApp({ AI_BASE_URL: llm.url });
    fx = await createAuthFixture();
    superAdmin = await admin.user.create({
      data: { name: "Equipe Plataforma", email: `plataforma-${fx.a.id}@teste.local`, passwordHash: await hash(PASSWORD), isSuperAdmin: true },
      select: { id: true, email: true },
    });
    await admin.tenantMember.create({ data: { tenantId: fx.c.id, userId: superAdmin.id, role: "ADMIN" } });
    token = await accessTokenFor(app, fx.user.email, fx.b.id);
    superToken = await accessTokenFor(app, superAdmin.email, fx.c.id);
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: superAdmin?.id } });
    await fx?.cleanup();
    await app?.close();
    await llm?.close();
  });

  const send = (tenantId: string, text: string) =>
    request(app.getHttpServer()).post("/api/suggestions").set("Authorization", `Bearer ${token}`).send({ tenantId, text });

  it("salva a sugestão e a IA classifica o assunto", async () => {
    subject = "integracoes";
    await send(fx.b.id, "Queria conectar o Anota AI também.").expect(204);
    await vi.waitFor(async () => {
      const saved = await admin.productSuggestion.findFirstOrThrow({ where: { tenantId: fx.b.id, text: "Queria conectar o Anota AI também." } });
      expect(saved.subject).toBe("integracoes");
    });
  });

  it("com a IA fora do ar, a sugestão fica salva sem assunto", async () => {
    subject = null;
    await send(fx.b.id, "Modo escuro, por favor.").expect(204);
    // A classificação roda depois da resposta: espera a chamada à LLM falhar.
    await vi.waitFor(() => expect(llm.requests.some((req) => JSON.stringify(req.body).includes("Modo escuro"))).toBe(true));
    const saved = await admin.productSuggestion.findFirstOrThrow({ where: { tenantId: fx.b.id, text: "Modo escuro, por favor." } });
    expect(saved.subject).toBeNull();
  });

  it("não aceita sugestão vazia nem em restaurante de que não é membro", async () => {
    await send(fx.b.id, "   ").expect(400);
    await send(fx.c.id, "Sugestão de fora").expect(403);
    expect(await admin.productSuggestion.count({ where: { tenantId: fx.c.id } })).toBe(0);
  });

  it("a plataforma vê as sugestões de todos os restaurantes; os outros não", async () => {
    const { body } = await request(app.getHttpServer()).get("/api/platform/suggestions").set("Authorization", `Bearer ${superToken}`).expect(200);
    const mine = body.filter((item: { tenantName: string }) => item.tenantName === "Teste B");
    expect(mine).toEqual([
      expect.objectContaining({ subject: null, text: "Modo escuro, por favor.", userName: "Atendente Teste" }),
      expect.objectContaining({ subject: "integracoes", text: "Queria conectar o Anota AI também.", userName: "Atendente Teste" }),
    ]);
    await request(app.getHttpServer()).get("/api/platform/suggestions").set("Authorization", `Bearer ${token}`).expect(403);
  });
});
