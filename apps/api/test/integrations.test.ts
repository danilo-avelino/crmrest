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
    expect(body).toEqual({ id: expect.any(String), type: "WHATSAPP", name: "Moby Dick (+1 555-736-8710)", externalId: "555000111", status: "CONNECTED" });
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
      expect(headers.location).toBe("http://painel.teste/configuracoes/integracoes?instagram=conectado");
      expect(graph.requests).toContainEqual(
        expect.objectContaining({ method: "POST", path: "/oauth/access_token", body: expect.stringContaining("code=codigo-do-login") }),
      );
      const channel = await admin.channel.findFirstOrThrow({ where: { tenantId: fx.tenant.id, type: "INSTAGRAM", externalId: "17841499990001" } });
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
      expect(graph.requests.some((r) => r.path === "/555000222/register")).toBe(false);
      expect(graph.requests).toContainEqual(
        expect.objectContaining({ method: "POST", path: "/999000333/subscribed_apps", authorization: "Bearer token-da-empresa-123" }),
      );
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

      // A mesma loja adicionada de novo volta a ficar conectada, no mesmo canal (o histórico continua ligado a ele).
      await disconnect(fx.ifood.id).expect(201);
      const again = await add({ type: "IFOOD", merchantId: fx.ifood.externalId }).expect(201);
      expect(again.body).toMatchObject({ id: fx.ifood.id, status: "CONNECTED" });
    });
  });

  it("várias lojas do iFood; adicionar a mesma loja de novo só atualiza", async () => {
    await add({ type: "IFOOD", merchantId: "loja-centro-1", name: "Centro" }).expect(201);
    await add({ type: "IFOOD", merchantId: "loja-shopping-2", name: "Shopping" }).expect(201);
    await add({ type: "IFOOD", merchantId: "loja-centro-1", name: "Centro (reformada)" }).expect(201);
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
});
