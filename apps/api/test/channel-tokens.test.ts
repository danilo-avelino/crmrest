import { decrypt, encrypt, parseEncryptionKey } from "@dishdesk/database";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelTokensService } from "../src/channels/channel-tokens.service.js";
import { admin, createChannelFixture, createTestApp, startMockGraph } from "./helpers.js";

const key = parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "");
const DAY_MS = 24 * 60 * 60 * 1000;
const secretsOf = async (id: string) =>
  JSON.parse(decrypt((await admin.channel.findUniqueOrThrow({ where: { id } })).credentials, key)) as {
    accessToken: string;
    tokenUpdatedAt?: string;
  };
const setSecrets = (id: string, secrets: object) =>
  admin.channel.update({ where: { id }, data: { credentials: encrypt(JSON.stringify(secrets), key), status: "CONNECTED", tokenExpiresAt: null } });

// Sempre por canal: o banco é o mesmo do desenvolvimento, e renovar todos trocaria tokens reais pelos da Graph falsa.
describe("renovação dos tokens dos canais", () => {
  let app: INestApplication;
  let graph: Awaited<ReturnType<typeof startMockGraph>>;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let tokens: ChannelTokensService;
  const refreshRequests = () => graph.requests.filter((r) => r.path.startsWith("/refresh_access_token"));

  beforeAll(async () => {
    graph = await startMockGraph();
    app = await createTestApp({
      CHANNELS_DRY_RUN: "false",
      INSTAGRAM_GRAPH_URL: `${graph.url}/v24.0`,
      META_GRAPH_URL: graph.url,
      META_APP_ID: "2491202674645060",
      META_APP_SECRET: "segredo-do-app-meta",
    });
    fx = await createChannelFixture();
    tokens = app.get(ChannelTokensService);
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
    await graph.close();
  });

  describe("Instagram", () => {
    it("lista só os canais de Instagram conectados", async () => {
      const rows = await admin.$queryRaw<{ id: string }[]>`SELECT id FROM app.instagram_channels()`;
      const ids = rows.map((row) => row.id);
      expect(ids).toContain(fx.instagram.id);
      expect(ids).not.toContain(fx.whatsapp.id);
    });

    it("renova o token sem data e grava o novo cifrado, com o vencimento", async () => {
      graph.reply(() => ({ status: 200, body: { access_token: "token-renovado", token_type: "bearer", expires_in: 5_184_000 } }));
      await tokens.refreshInstagram(fx.tenant.id, fx.instagram.id);

      expect(refreshRequests()).toEqual([
        expect.objectContaining({ method: "GET", path: "/refresh_access_token?grant_type=ig_refresh_token&access_token=token-de-teste" }),
      ]);
      const secrets = await secretsOf(fx.instagram.id);
      expect(secrets.accessToken).toBe("token-renovado");
      expect(Date.now() - Date.parse(secrets.tokenUpdatedAt!)).toBeLessThan(60_000);
      const { tokenExpiresAt } = await admin.channel.findUniqueOrThrow({ where: { id: fx.instagram.id } });
      expect(Math.round((tokenExpiresAt!.getTime() - Date.now()) / DAY_MS)).toBe(60);
      graph.resetReply();
    });

    it("não renova de novo antes de 7 dias", async () => {
      await tokens.refreshInstagram(fx.tenant.id, fx.instagram.id);
      expect(refreshRequests()).toHaveLength(1);
    });

    it("falha da Meta mantém o token atual", async () => {
      await setSecrets(fx.instagram.id, { accessToken: "token-antigo", tokenUpdatedAt: "2026-01-01T00:00:00.000Z" });
      graph.reply(() => ({ status: 400, body: { error: { message: "Session has expired" } } }));

      await expect(tokens.refreshInstagram(fx.tenant.id, fx.instagram.id)).rejects.toThrow("Session has expired");
      expect((await secretsOf(fx.instagram.id)).accessToken).toBe("token-antigo");
      graph.resetReply();
    });
  });

  describe("WhatsApp", () => {
    const expiresAt = Math.floor((Date.now() + 20 * DAY_MS) / 1000);
    const exchanges = () => graph.requests.filter((r) => r.path.startsWith("/oauth/access_token?"));
    // debug_token responde com a validade configurada; a troca devolve um token novo de 60 dias.
    const meta = (debug: object) =>
      graph.reply((req) => {
        if (req.path.startsWith("/debug_token?")) return { status: 200, body: { data: debug } };
        if (req.path.startsWith("/oauth/access_token?")) return { status: 200, body: { access_token: "token-whatsapp-renovado", expires_in: 5_184_000 } };
        return { status: 404, body: { error: { message: "Não encontrado" } } };
      });

    it("lista só os canais de WhatsApp conectados", async () => {
      const rows = await admin.$queryRaw<{ id: string }[]>`SELECT id FROM app.whatsapp_channels()`;
      const ids = rows.map((row) => row.id);
      expect(ids).toContain(fx.whatsapp.id);
      expect(ids).not.toContain(fx.instagram.id);
    });

    it("token de 60 dias com mais de 7 dias: renova pela troca da Meta e grava o novo vencimento", async () => {
      await setSecrets(fx.whatsapp.id, { accessToken: "token-whatsapp", wabaId: "waba-teste", tokenUpdatedAt: "2026-01-01T00:00:00.000Z" });
      meta({ is_valid: true, expires_at: expiresAt });
      const before = exchanges().length;
      await tokens.refreshWhatsApp(fx.tenant.id, fx.whatsapp.id);

      const exchange = exchanges().slice(before);
      expect(exchange).toHaveLength(1);
      const params = new URLSearchParams(exchange[0]!.path.split("?")[1]);
      expect(Object.fromEntries(params)).toMatchObject({
        grant_type: "fb_exchange_token",
        client_id: "2491202674645060",
        set_token_expires_in_60_days: "true",
        fb_exchange_token: "token-whatsapp",
      });
      const secrets = await secretsOf(fx.whatsapp.id);
      expect(secrets).toMatchObject({ accessToken: "token-whatsapp-renovado", wabaId: "waba-teste" });
      const { tokenExpiresAt } = await admin.channel.findUniqueOrThrow({ where: { id: fx.whatsapp.id } });
      expect(Math.round((tokenExpiresAt!.getTime() - Date.now()) / DAY_MS)).toBe(60);
      graph.resetReply();
    });

    it("token permanente: não troca (a troca o faria vencer) e não grava vencimento", async () => {
      await setSecrets(fx.whatsapp.id, { accessToken: "token-permanente", wabaId: "waba-teste", tokenUpdatedAt: "2026-01-01T00:00:00.000Z" });
      meta({ is_valid: true, expires_at: 0 });
      const before = exchanges().length;
      await tokens.refreshWhatsApp(fx.tenant.id, fx.whatsapp.id);

      expect(exchanges()).toHaveLength(before);
      expect((await secretsOf(fx.whatsapp.id)).accessToken).toBe("token-permanente");
      expect((await admin.channel.findUniqueOrThrow({ where: { id: fx.whatsapp.id } })).tokenExpiresAt).toBeNull();
      graph.resetReply();
    });

    it("renovação recusada: o vencimento fica gravado para o painel avisar", async () => {
      await setSecrets(fx.whatsapp.id, { accessToken: "token-whatsapp", wabaId: "waba-teste", tokenUpdatedAt: "2026-01-01T00:00:00.000Z" });
      graph.reply((req) =>
        req.path.startsWith("/debug_token?")
          ? { status: 200, body: { data: { is_valid: true, expires_at: expiresAt } } }
          : { status: 400, body: { error: { message: "Invalid token" } } },
      );

      await expect(tokens.refreshWhatsApp(fx.tenant.id, fx.whatsapp.id)).rejects.toThrow("Invalid token");
      const channel = await admin.channel.findUniqueOrThrow({ where: { id: fx.whatsapp.id } });
      expect(channel.tokenExpiresAt?.getTime()).toBe(expiresAt * 1000);
      expect(channel.status).toBe("CONNECTED");
      expect((await secretsOf(fx.whatsapp.id)).accessToken).toBe("token-whatsapp");
      graph.resetReply();
    });

    it("token recusado pela Meta: o canal fica com erro, e a Inbox pede para reconectar", async () => {
      await setSecrets(fx.whatsapp.id, { accessToken: "token-revogado", wabaId: "waba-teste" });
      meta({ is_valid: false, expires_at: 0 });
      await tokens.refreshWhatsApp(fx.tenant.id, fx.whatsapp.id);
      expect((await admin.channel.findUniqueOrThrow({ where: { id: fx.whatsapp.id } })).status).toBe("ERROR");
      graph.resetReply();
    });
  });
});
