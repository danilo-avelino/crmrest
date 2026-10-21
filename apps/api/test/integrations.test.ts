import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { decrypt, parseEncryptionKey } from "@dishdesk/database";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import type { Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUEUES } from "../src/queues/queues.module.js";
import { accessTokenFor, admin, createChannelFixture, createTestApp, PASSWORD, startMockGraph } from "./helpers.js";

/** API do Cardápio Web para conferir a chave (aceita uma, recusa as outras); a base de clientes vem vazia. */
async function startMockCardapioWeb() {
  const server = createServer((req, res) => {
    const ok = req.headers["x-api-key"] === "chave-boa-da-loja";
    const body = !ok
      ? { message: "Unauthorized" }
      : req.url?.startsWith("/api/partner/v1/merchant/customers")
        ? { customers: [], pagination: { current_page: 1, total_pages: 1, total_customers: 0 } }
        : [];
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("Integrações (Configurações)", () => {
  let app: INestApplication;
  let graph: Awaited<ReturnType<typeof startMockGraph>>;
  let cardapioWeb: Awaited<ReturnType<typeof startMockCardapioWeb>>;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let other: Awaited<ReturnType<typeof createChannelFixture>>;
  let adminUserId: string;
  let agentToken: string;
  let adminToken: string;

  beforeAll(async () => {
    graph = await startMockGraph();
    // Graph API (Meta e Instagram): número, conta do Instagram, inscrição nos webhooks e um token recusado.
    graph.reply((req) => {
      if (req.authorization === "Bearer token-recusado-pela-meta") {
        return { status: 401, body: { error: { message: "Invalid OAuth access token." } } };
      }
      if (req.method === "GET" && req.path.startsWith("/555000111?")) {
        return { status: 200, body: { id: "555000111", display_phone_number: "+1 555-736-8710", verified_name: "Moby Dick" } };
      }
      if (req.method === "GET" && req.path.startsWith("/me?")) return { status: 200, body: { user_id: 17841499990001, username: "mobydick.lanches" } };
      if (req.method === "POST" && req.path.includes("/subscribed_apps")) return { status: 200, body: { success: true } };
      // Login do Instagram: código → token curto → token de 60 dias.
      if (req.method === "POST" && req.path === "/oauth/access_token") {
        return String(req.body).includes("code=codigo-recusado")
          ? { status: 400, body: { error_type: "OAuthException", code: 400, error_message: "Invalid authorization code" } }
          : { status: 200, body: { data: [{ access_token: "token-curto-do-instagram", user_id: 17841499990001 }] } };
      }
      if (req.method === "GET" && req.path.startsWith("/access_token?grant_type=ig_exchange_token")) {
        return { status: 200, body: { access_token: "token-longo-do-instagram", expires_in: 5_184_000 } };
      }
      // Cadastro incorporado do WhatsApp: código → token da empresa; números da conta; registro de número novo.
      if (req.method === "GET" && req.path.startsWith("/oauth/access_token?")) return { status: 200, body: { access_token: "token-da-empresa-123" } };
      if (req.method === "GET" && req.path.startsWith("/999000333/phone_numbers")) return { status: 200, body: { data: [{ id: "555000222" }] } };
      if (req.method === "GET" && /^\/555000(222|444)\?/.test(req.path)) {
        return { status: 200, body: { display_phone_number: "+55 86 99973-1647", verified_name: "Danilo Lanches" } };
      }
      if (req.method === "POST" && req.path === "/555000444/register") return { status: 200, body: { success: true } };
      // Número que já estava na Cloud API com outro PIN: a Meta recusa o registro.
      if (req.method === "POST" && req.path === "/555000222/register") return { status: 400, body: { error: { message: "PIN incorreto" } } };
      // Sem a conta na mensagem da janela: a conta liberada vem nas permissões do token.
      if (req.method === "GET" && req.path.startsWith("/debug_token?")) {
        return { status: 200, body: { data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: ["999000333"] }] } } };
      }
      return { status: 404, body: { error: { message: "Não encontrado" } } };
    });
    cardapioWeb = await startMockCardapioWeb();
    app = await createTestApp({
      CHANNELS_DRY_RUN: "false",
      META_GRAPH_URL: graph.url,
      INSTAGRAM_GRAPH_URL: graph.url,
      INSTAGRAM_OAUTH_URL: graph.url,
      INSTAGRAM_APP_ID: "1092653833350685",
      INSTAGRAM_APP_SECRET: "segredo-do-app-instagram",
      INSTAGRAM_REDIRECT_URI: "http://painel.teste/api/integrations/instagram/callback",
      META_APP_ID: "2491202674645060",
      META_APP_SECRET: "segredo-do-app-meta",
      META_EMBEDDED_SIGNUP_CONFIG_ID: "config-123",
      WEB_ORIGIN: "http://painel.teste",
      CARDAPIO_WEB_API_URL: cardapioWeb.url,
    });
    // Só a conferência da chave usa a API falsa: sem o polling agendado.
    await app.get<Queue>(getQueueToken(QUEUES.cardapioWeb)).removeJobScheduler("cardapio-web-polling");

    fx = await createChannelFixture(); // WhatsApp, Instagram e iFood conectados; o usuário é atendente
    other = await createChannelFixture();
    const adminUser = await admin.user.create({
      data: {
        name: "Admin Integrações",
        email: `admin-${fx.tenant.id}@teste.local`,
        passwordHash: await hash(PASSWORD),
        memberships: { create: { tenantId: fx.tenant.id, role: "ADMIN" } },
      },
    });
    adminUserId = adminUser.id;
    agentToken = await accessTokenFor(app, fx.user.email, fx.tenant.id);
    adminToken = await accessTokenFor(app, adminUser.email, fx.tenant.id);
  });

  afterAll(async () => {
    await admin.user.deleteMany({ where: { id: adminUserId } });
    await fx?.cleanup();
    await other?.cleanup();
    await app?.close();
    await graph?.close();
    await cardapioWeb?.close();
  });

  const list = (token: string, tenantId = fx.tenant.id) =>
    request(app.getHttpServer()).get(`/api/integrations?tenantId=${tenantId}`).set("Authorization", `Bearer ${token}`);
  const add = (body: object, token = adminToken) =>
    request(app.getHttpServer()).post(`/api/integrations/${fx.tenant.id}`).set("Authorization", `Bearer ${token}`).send(body);

  it("lista as integrações do restaurante; atendente vê, mas não adiciona", async () => {
    const { body } = await list(agentToken).expect(200);
    expect(body).toMatchObject({ tenantId: fx.tenant.id, canEdit: false, platform: { ifood: false, cardapioWeb: true } });
    expect(body.integrations.map((i: { type: string }) => i.type)).toEqual(["WHATSAPP", "INSTAGRAM", "IFOOD"]);
    expect(JSON.stringify(body)).not.toContain("token-de-teste"); // credenciais nunca saem da API

    await add({ type: "IFOOD", merchantId: "loja-qualquer" }, agentToken).expect(403);
    await list(agentToken, other.tenant.id).expect(403); // outro restaurante
  });

  it("WhatsApp: confere o número, inscreve a conta nos webhooks e guarda o token cifrado", async () => {
    const { body } = await add({ type: "WHATSAPP", phoneNumberId: "555000111", wabaId: "999000222", accessToken: "token-do-system-user-123" }).expect(201);
    expect(body).toEqual({
      id: expect.any(String),
      type: "WHATSAPP",
      name: "Moby Dick (+1 555-736-8710)",
      externalId: "555000111",
      status: "CONNECTED",
      servedTenantIds: [],
    });
    expect(graph.requests).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/999000222/subscribed_apps", authorization: "Bearer token-do-system-user-123" }),
    );
    const channel = await admin.channel.findUniqueOrThrow({ where: { id: body.id } });
    const secrets = JSON.parse(decrypt(channel.credentials, parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "")));
    expect(secrets).toMatchObject({ accessToken: "token-do-system-user-123", wabaId: "999000222" });
  });

  it("credencial recusada pela Meta: nada é cadastrado e o motivo aparece", async () => {
    const { body } = await add({ type: "WHATSAPP", phoneNumberId: "555000999", wabaId: "999000222", accessToken: "token-recusado-pela-meta" }).expect(422);
    expect(body.message).toBe("Não foi possível conectar o WhatsApp: Meta: Invalid OAuth access token.");
    expect(await admin.channel.count({ where: { externalId: "555000999" } })).toBe(0);
  });

  it("Instagram: descobre a conta pelo token e a inscreve para receber as DMs", async () => {
    const { body } = await add({ type: "INSTAGRAM", accessToken: "token-do-instagram-123" }).expect(201);
    expect(body).toMatchObject({ type: "INSTAGRAM", name: "@mobydick.lanches", externalId: "17841499990001" });
    expect(graph.requests).toContainEqual(expect.objectContaining({ method: "POST", path: "/me/subscribed_apps?subscribed_fields=messages" }));
  });

  describe("login do Instagram", () => {
    const loginUrl = async () => {
      const { body } = await request(app.getHttpServer())
        .get(`/api/integrations/${fx.tenant.id}/instagram/login`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      return new URL(body.url);
    };
    // Volta do Instagram: sem sessão, como o navegador chega depois do login.
    const callback = (query: Record<string, string>) =>
      request(app.getHttpServer()).get(`/api/integrations/instagram/callback?${new URLSearchParams(query).toString()}`).expect(302);
    const backParams = (location = "") => Object.fromEntries(new URL(location).searchParams);

    it("abre a tela de login do Instagram; só o admin pede", async () => {
      const url = await loginUrl();
      expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
      expect(url.searchParams.get("client_id")).toBe("1092653833350685");
      expect(url.searchParams.get("redirect_uri")).toBe("http://painel.teste/api/integrations/instagram/callback");
      expect(url.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_manage_messages");
      await request(app.getHttpServer()).get(`/api/integrations/${fx.tenant.id}/instagram/login`).set("Authorization", `Bearer ${agentToken}`).expect(403);
    });

    it("na volta, troca o código pelo token de 60 dias, conecta a conta e devolve ao painel", async () => {
      const state = (await loginUrl()).searchParams.get("state") ?? "";
      const { headers } = await callback({ code: "codigo-do-login", state });
      const channel = await admin.channel.findFirstOrThrow({ where: { tenantId: fx.tenant.id, type: "INSTAGRAM", externalId: "17841499990001" } });
      // A conta volta no endereço: o painel pergunta em seguida quais restaurantes ela atende.
      expect(headers.location).toBe(`http://painel.teste/configuracoes/integracoes?instagram=conectado&canal=${channel.id}`);
      expect(graph.requests).toContainEqual(
        expect.objectContaining({ method: "POST", path: "/oauth/access_token", body: expect.stringContaining("code=codigo-do-login") }),
      );
      const secrets = JSON.parse(decrypt(channel.credentials, parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "")));
      expect(secrets.accessToken).toBe("token-longo-do-instagram");
    });

    it("state adulterado, login cancelado ou código recusado voltam ao painel com o motivo", async () => {
      const state = (await loginUrl()).searchParams.get("state") ?? "";
      const forged = `${Buffer.from(JSON.stringify({ tenantId: other.tenant.id, userId: adminUserId, exp: Date.now() + 60_000 })).toString("base64url")}.${state.split(".")[1]}`;
      expect(backParams((await callback({ code: "x", state: forged })).headers.location)).toEqual({
        instagram: "erro",
        motivo: "O login expirou. Tente conectar de novo.",
      });
      expect(backParams((await callback({ error: "access_denied", state })).headers.location).motivo).toBe("O login no Instagram foi cancelado.");
      expect(backParams((await callback({ code: "codigo-recusado", state })).headers.location).motivo).toBe(
        "Não foi possível conectar o Instagram: Meta: Invalid authorization code (troca do código do login).",
      );
    });
  });

  describe("cadastro incorporado do WhatsApp", () => {
    const signup = (body: object, token = adminToken) =>
      request(app.getHttpServer()).post(`/api/integrations/${fx.tenant.id}/whatsapp/signup`).set("Authorization", `Bearer ${token}`).send(body);

    it("lista os ids públicos para a janela da Meta", async () => {
      const { body } = await list(adminToken).expect(200);
      expect(body.platform).toMatchObject({ instagramLogin: true, whatsappSignup: { appId: "2491202674645060", configId: "config-123" } });
    });

    it("Coexistência: acha o número da conta, não registra de novo e inscreve a conta nos webhooks", async () => {
      const { body } = await signup({ code: "codigo-da-janela-meta", wabaId: "999000333", coexistence: true }).expect(201);
      expect(body).toMatchObject({ type: "WHATSAPP", externalId: "555000222", name: "Danilo Lanches (+55 86 99973-1647)" });
      expect(graph.requests.some((r) => r.path.startsWith("/oauth/access_token?") && r.path.includes("code=codigo-da-janela-meta"))).toBe(true);
      // Sem o redirect_uri da janela, a troca vai com ele vazio.
      expect(graph.requests.some((r) => r.path.startsWith("/oauth/access_token?") && r.path.endsWith("&redirect_uri="))).toBe(true);
      expect(graph.requests.some((r) => r.path === "/555000222/register")).toBe(false);
      expect(graph.requests).toContainEqual(
        expect.objectContaining({ method: "POST", path: "/999000333/subscribed_apps", authorization: "Bearer token-da-empresa-123" }),
      );
    });

    it("troca o código com o mesmo redirect_uri que o SDK usou na janela da Meta", async () => {
      const redirectUri = "https://staticxx.facebook.com/x/connect/xd_arbiter/?version=46#cb=f1&origin=https%3A%2F%2Fwww.dishdesk.com.br";
      await signup({ code: "codigo-com-redirect", wabaId: "999000333", coexistence: true, redirectUri }).expect(201);
      const exchange = graph.requests.find((r) => r.path.startsWith("/oauth/access_token?") && r.path.includes("code=codigo-com-redirect"));
      expect(new URLSearchParams(exchange?.path.split("?").slice(1).join("?")).get("redirect_uri")).toBe(redirectUri);
    });

    it("recusa redirect_uri que não é da Meta", async () => {
      await signup({ code: "codigo-da-janela-meta", wabaId: "999000333", redirectUri: "https://exemplo.com/" }).expect(400);
    });

    it("número novo: registra na Cloud API com um PIN guardado cifrado", async () => {
      const { body } = await signup({ code: "codigo-da-janela-meta", wabaId: "999000333", phoneNumberId: "555000444", coexistence: false }).expect(201);
      const register = graph.requests.find((r) => r.path === "/555000444/register");
      expect(register?.body).toEqual({ messaging_product: "whatsapp", pin: expect.stringMatching(/^\d{6}$/) });
      const channel = await admin.channel.findUniqueOrThrow({ where: { id: body.id } });
      const secrets = JSON.parse(decrypt(channel.credentials, parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "")));
      expect(secrets).toMatchObject({ accessToken: "token-da-empresa-123", wabaId: "999000333", pin: (register?.body as { pin: string }).pin });
    });

    it("sem a conta na mensagem da janela (configurações anteriores): descobre a conta pelas permissões do token", async () => {
      const { body } = await signup({ code: "codigo-da-janela-meta" }).expect(201);
      expect(body).toMatchObject({ type: "WHATSAPP", externalId: "555000222" });
      expect(graph.requests.some((r) => r.path.startsWith("/debug_token?") && r.path.includes("input_token=token-da-empresa-123"))).toBe(true);
    });

    it("número que já estava na Cloud API: o registro recusado não impede a conexão", async () => {
      const { body } = await signup({ code: "codigo-da-janela-meta", wabaId: "999000333", phoneNumberId: "555000222", coexistence: false }).expect(201);
      const channel = await admin.channel.findUniqueOrThrow({ where: { id: body.id } });
      const secrets = JSON.parse(decrypt(channel.credentials, parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "")));
      expect(secrets).toMatchObject({ accessToken: "token-da-empresa-123", wabaId: "999000333" });
      expect(secrets.pin).toBeUndefined();
    });

    it("atendente não conecta", async () => {
      await signup({ code: "codigo-da-janela-meta", wabaId: "999000333", coexistence: true }, agentToken).expect(403);
    });
  });

  describe("desconectar", () => {
    const disconnect = (channelId: string, token = adminToken) =>
      request(app.getHttpServer()).post(`/api/integrations/${fx.tenant.id}/${channelId}/disconnect`).set("Authorization", `Bearer ${token}`);
    const resolve = (type: string, externalId: string) =>
      admin.$queryRaw<{ id: string }[]>`SELECT id FROM app.resolve_channel(${type}::"ChannelType", ${externalId})`;

    it("só o admin desconecta, e só contas do próprio restaurante", async () => {
      await disconnect(fx.whatsapp.id, agentToken).expect(403);
      await disconnect(other.whatsapp.id).expect(404);
    });

    it("apaga a credencial e para de aceitar os webhooks do canal; conectar de novo reativa", async () => {
      expect(await resolve("WHATSAPP", fx.whatsapp.externalId)).toHaveLength(1);
      const { body } = await disconnect(fx.whatsapp.id).expect(201);
      expect(body).toMatchObject({ id: fx.whatsapp.id, status: "DISCONNECTED" });
      const channel = await admin.channel.findUniqueOrThrow({ where: { id: fx.whatsapp.id } });
      expect(JSON.parse(decrypt(channel.credentials, parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "")))).toEqual({});
      expect(await resolve("WHATSAPP", fx.whatsapp.externalId)).toHaveLength(0);

      // A mesma loja adicionada de novo volta a ficar conectada, no mesmo canal (o histórico continua ligado a ele), e
      // com a hora da nova conexão (o que veio antes não aciona automações).
      await disconnect(fx.ifood.id).expect(201);
      const reconnectedFrom = new Date();
      const again = await add({ type: "IFOOD", merchantId: fx.ifood.externalId }).expect(201);
      expect(again.body).toMatchObject({ id: fx.ifood.id, status: "CONNECTED" });
      expect((await admin.channel.findUniqueOrThrow({ where: { id: fx.ifood.id } })).connectedAt!.getTime()).toBeGreaterThanOrEqual(reconnectedFrom.getTime());
    });
  });

  it("várias lojas do iFood; adicionar a mesma loja de novo só atualiza", async () => {
    await add({ type: "IFOOD", merchantId: "loja-centro-1", name: "Centro" }).expect(201);
    await add({ type: "IFOOD", merchantId: "loja-shopping-2", name: "Shopping" }).expect(201);
    const centro = () => admin.channel.findFirstOrThrow({ where: { type: "IFOOD", externalId: "loja-centro-1" } });
    const { connectedAt } = await centro();
    expect(connectedAt).not.toBeNull();
    await add({ type: "IFOOD", merchantId: "loja-centro-1", name: "Centro (reformada)" }).expect(201);
    // Já conectada: atualizar não muda a hora da conexão.
    expect((await centro()).connectedAt).toEqual(connectedAt);
    const { body } = await list(adminToken).expect(200);
    const ifood = body.integrations.filter((i: { type: string }) => i.type === "IFOOD").map((i: { name: string }) => i.name);
    expect(ifood).toHaveLength(3); // a da fixture + Centro + Shopping
    expect(ifood).toEqual(expect.arrayContaining(["Centro (reformada)", "Shopping"]));
    expect(body.canEdit).toBe(true);
  });

  it("Cardápio Web: testa a chave antes de salvar e, conectada, importa a base de clientes", async () => {
    const queue = app.get<Queue>(getQueueToken(QUEUES.cardapioWeb));
    const imports = async () =>
      (await queue.getJobs(["waiting", "active", "delayed", "completed", "failed"])).filter((job) => job.name === "import-customers" && job.data.tenantId === fx.tenant.id);
    const refused = await add({ type: "CARDAPIO_WEB", storeId: "777", apiKey: "chave-errada-da-loja" }).expect(422);
    expect(refused.body.message).toBe("Não foi possível conectar o Cardápio Web: a credencial não foi aceita.");
    expect(await imports()).toHaveLength(0);
    const { body } = await add({ type: "CARDAPIO_WEB", storeId: "777", apiKey: "chave-boa-da-loja" }).expect(201);
    expect(body).toMatchObject({ type: "CARDAPIO_WEB", name: "Loja 777", externalId: "777", status: "CONNECTED" });
    expect((await imports()).map((job) => job.data)).toEqual([{ tenantId: fx.tenant.id, channelId: body.id, page: 1, imported: 0 }]);
  });

  it("conta já conectada a outro restaurante é recusada", async () => {
    const { body } = await add({ type: "IFOOD", merchantId: other.ifood.externalId }).expect(409);
    expect(body.message).toBe("Esta conta já está conectada a outro restaurante.");
  });

  it("recusa dados fora do formato antes de falar com qualquer sistema", async () => {
    const before = graph.requests.length;
    await add({ type: "WHATSAPP", phoneNumberId: "abc", wabaId: "999000222", accessToken: "token-do-system-user-123" }).expect(400);
    await add({ type: "TELEGRAM", token: "x" }).expect(400);
    expect(graph.requests.length).toBe(before);
  });

  it("renomear: só o admin, só contas do próprio restaurante, e o nome novo aparece na lista", async () => {
    const rename = (channelId: string, body: object, token = adminToken) =>
      request(app.getHttpServer()).patch(`/api/integrations/${fx.tenant.id}/${channelId}`).set("Authorization", `Bearer ${token}`).send(body);
    await rename(fx.ifood.id, { name: "Loja Centro" }, agentToken).expect(403);
    await rename(other.ifood.id, { name: "Loja Centro" }).expect(404);
    await rename(fx.ifood.id, { name: "   " }).expect(400);
    await rename(fx.ifood.id, { name: "x".repeat(61) }).expect(400);

    const { body } = await rename(fx.ifood.id, { name: "  Loja Centro  " }).expect(200);
    expect(body).toMatchObject({ id: fx.ifood.id, name: "Loja Centro", externalId: fx.ifood.externalId });
    const listed = (await list(adminToken).expect(200)).body.integrations.find((i: { id: string }) => i.id === fx.ifood.id);
    expect(listed.name).toBe("Loja Centro");
  });

  describe("excluir", () => {
    const remove = (channelId: string, token = adminToken) =>
      request(app.getHttpServer()).delete(`/api/integrations/${fx.tenant.id}/${channelId}`).set("Authorization", `Bearer ${token}`);
    const ids = async () => (await list(adminToken).expect(200)).body.integrations.map((i: { id: string }) => i.id);

    it("só o admin exclui, e só contas do próprio restaurante", async () => {
      await remove(fx.instagram.id, agentToken).expect(403);
      await remove(other.instagram.id).expect(404);
    });

    it("desconecta e some do painel e dos avisos da Inbox; o canal fica no banco e conectar de novo o traz de volta", async () => {
      const store = (await add({ type: "CARDAPIO_WEB", storeId: "888", apiKey: "chave-boa-da-loja" }).expect(201)).body;
      await remove(store.id).expect(204);

      expect(await ids()).not.toContain(store.id);
      const health = await request(app.getHttpServer()).get("/api/channels").set("Authorization", `Bearer ${adminToken}`).expect(200);
      expect(health.body.map((channel: { id: string }) => channel.id)).not.toContain(store.id);
      const channel = await admin.channel.findUniqueOrThrow({ where: { id: store.id } });
      expect(channel).toMatchObject({ status: "DISCONNECTED", externalId: "888", deletedAt: expect.any(Date) });
      expect(JSON.parse(decrypt(channel.credentials, parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "")))).toEqual({});

      // Já excluída: não dá para excluir nem desconectar de novo.
      await remove(store.id).expect(404);
      await request(app.getHttpServer()).post(`/api/integrations/${fx.tenant.id}/${store.id}/disconnect`).set("Authorization", `Bearer ${adminToken}`).expect(404);

      const again = await add({ type: "CARDAPIO_WEB", storeId: "888", apiKey: "chave-boa-da-loja" }).expect(201);
      expect(again.body).toMatchObject({ id: store.id, status: "CONNECTED" });
      expect(await ids()).toContain(store.id);
      expect((await admin.channel.findUniqueOrThrow({ where: { id: store.id } })).deletedAt).toBeNull();
    });
  });

  // Por último: fx (quem conecta) e other (quem já usou a conta) viram restaurantes cadastrados pelo site.
  describe("teste grátis repetido", () => {
    const days = (count: number) => new Date(Date.now() + count * 24 * 60 * 60 * 1000);
    const tenant = (id: string) => admin.tenant.findUniqueOrThrow({ where: { id } });
    const inTrial = (id: string, trialEndsAt: Date) =>
      admin.tenant.update({ where: { id }, data: { trialEndsAt, paidUntil: null, trialRevokedAt: null } });
    const storeOf = (tenantId: string) =>
      admin.channel.create({
        data: { tenantId, type: "IFOOD", name: "Loja", externalId: randomUUID(), credentials: Buffer.from("x"), status: "CONNECTED" },
      });
    const channel = (id: string) => admin.channel.findUniqueOrThrow({ where: { id } });

    it("conta de um teste encerrado há menos de 60 dias: o teste daqui é encerrado e o restaurante fica bloqueado", async () => {
      await inTrial(other.tenant.id, days(-10));
      await inTrial(fx.tenant.id, days(10));

      const { body } = await add({ type: "IFOOD", merchantId: other.ifood.externalId }).expect(402);
      expect(body.message).toBe("Esta conta já foi usada em um teste grátis nos últimos 60 dias. Para continuar, assine um plano.");
      const blocked = await tenant(fx.tenant.id);
      expect(blocked.trialRevokedAt).not.toBeNull();
      expect(blocked.trialEndsAt!.getTime()).toBeLessThanOrEqual(Date.now());
      expect(await channel(other.ifood.id)).toMatchObject({ tenantId: other.tenant.id, externalId: other.ifood.externalId, status: "CONNECTED" });

      const agent = request.agent(app.getHttpServer());
      const login = await agent.post("/api/auth/login").send({ email: fx.user.email, password: PASSWORD }).expect(200);
      expect(login.body.tenants).toMatchObject([{ id: fx.tenant.id, blockedBy: "reused" }]);
      await agent.post("/api/auth/context").send({ mode: "tenant", tenantId: fx.tenant.id }).expect(402);
    });

    it("login do Instagram com a conta de outro teste: volta direto para a tela de pagamento", async () => {
      // A conta conectada nos testes acima passa a ser do outro restaurante.
      await admin.channel.updateMany({ where: { type: "INSTAGRAM", externalId: "17841499990001" }, data: { tenantId: other.tenant.id } });
      await inTrial(fx.tenant.id, days(10));
      const login = await request(app.getHttpServer())
        .get(`/api/integrations/${fx.tenant.id}/instagram/login`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      const state = new URL(login.body.url).searchParams.get("state") ?? "";

      const { headers } = await request(app.getHttpServer())
        .get(`/api/integrations/instagram/callback?${new URLSearchParams({ code: "codigo-do-login", state }).toString()}`)
        .expect(302);
      expect(headers.location).toBe(`http://painel.teste/assinatura?restaurante=${fx.tenant.id}`);
      expect((await tenant(fx.tenant.id)).trialRevokedAt).not.toBeNull();
    });

    it("depois de pagar, a conta sai do teste antigo (que fica com o histórico) e conecta aqui", async () => {
      await admin.tenant.update({ where: { id: fx.tenant.id }, data: { paidUntil: days(30) } });

      const { body } = await add({ type: "IFOOD", merchantId: other.ifood.externalId }).expect(201);
      expect(body).toMatchObject({ externalId: other.ifood.externalId, status: "CONNECTED" });
      const released = await channel(other.ifood.id);
      expect(released).toMatchObject({ tenantId: other.tenant.id, externalId: `${other.ifood.externalId}#${other.ifood.id}`, status: "DISCONNECTED" });
      expect(JSON.parse(decrypt(released.credentials, parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "")))).toEqual({});
    });

    it("teste antigo encerrado há 60 dias ou mais: a conta entra num teste novo", async () => {
      const store = await storeOf(other.tenant.id);
      await inTrial(other.tenant.id, days(-61));
      await inTrial(fx.tenant.id, days(10));

      await add({ type: "IFOOD", merchantId: store.externalId }).expect(201);
      expect(await tenant(fx.tenant.id)).toMatchObject({ trialRevokedAt: null });
      expect((await channel(store.id)).status).toBe("DISCONNECTED");
    });

    it("conta em uso num teste em andamento continua do outro restaurante, mesmo para quem paga", async () => {
      const store = await storeOf(other.tenant.id);
      await inTrial(other.tenant.id, days(5));
      await admin.tenant.update({ where: { id: fx.tenant.id }, data: { paidUntil: days(30) } });

      const { body } = await add({ type: "IFOOD", merchantId: store.externalId }).expect(409);
      expect(body.message).toBe("Esta conta já está conectada a outro restaurante.");
      expect((await channel(store.id)).status).toBe("CONNECTED");

      // Desconectada lá, pode ser conectada aqui.
      await admin.channel.update({ where: { id: store.id }, data: { status: "DISCONNECTED" } });
      await add({ type: "IFOOD", merchantId: store.externalId }).expect(201);
    });
  });
});
