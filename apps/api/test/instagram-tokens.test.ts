import { decrypt, encrypt, parseEncryptionKey } from "@comanda/database";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InstagramTokensService } from "../src/channels/instagram-tokens.service.js";
import { admin, createChannelFixture, createTestApp, startMockGraph } from "./helpers.js";

const key = parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "");
const secretsOf = async (id: string) =>
  JSON.parse(decrypt((await admin.channel.findUniqueOrThrow({ where: { id } })).credentials, key)) as {
    accessToken: string;
    tokenUpdatedAt?: string;
  };

// Sempre por canal: o banco é o mesmo do desenvolvimento, e renovar todos trocaria tokens reais pelos da Graph falsa.
describe("renovação dos tokens do Instagram", () => {
  let app: INestApplication;
  let graph: Awaited<ReturnType<typeof startMockGraph>>;
  let fx: Awaited<ReturnType<typeof createChannelFixture>>;
  let tokens: InstagramTokensService;
  const refreshRequests = () => graph.requests.filter((r) => r.path.startsWith("/refresh_access_token"));

  beforeAll(async () => {
    graph = await startMockGraph();
    app = await createTestApp({ CHANNELS_DRY_RUN: "false", INSTAGRAM_GRAPH_URL: `${graph.url}/v24.0` });
    fx = await createChannelFixture();
    tokens = app.get(InstagramTokensService);
  });

  afterAll(async () => {
    await fx.cleanup();
    await app.close();
    await graph.close();
  });

  it("lista só os canais de Instagram conectados", async () => {
    const rows = await admin.$queryRaw<{ id: string }[]>`SELECT id FROM app.instagram_channels()`;
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(fx.instagram.id);
    expect(ids).not.toContain(fx.whatsapp.id);
  });

  it("renova o token sem data e grava o novo cifrado", async () => {
    graph.reply(() => ({ status: 200, body: { access_token: "token-renovado", token_type: "bearer", expires_in: 5_184_000 } }));
    await tokens.refreshChannel(fx.tenant.id, fx.instagram.id);

    expect(refreshRequests()).toEqual([
      expect.objectContaining({ method: "GET", path: "/refresh_access_token?grant_type=ig_refresh_token&access_token=token-de-teste" }),
    ]);
    const secrets = await secretsOf(fx.instagram.id);
    expect(secrets.accessToken).toBe("token-renovado");
    expect(Date.now() - Date.parse(secrets.tokenUpdatedAt!)).toBeLessThan(60_000);
  });

  it("não renova de novo antes de 7 dias", async () => {
    await tokens.refreshChannel(fx.tenant.id, fx.instagram.id);
    expect(refreshRequests()).toHaveLength(1);
  });

  it("falha da Meta mantém o token atual", async () => {
    await admin.channel.update({
      where: { id: fx.instagram.id },
      data: { credentials: encrypt(JSON.stringify({ accessToken: "token-antigo", tokenUpdatedAt: "2026-01-01T00:00:00.000Z" }), key) },
    });
    graph.reply(() => ({ status: 400, body: { error: { message: "Session has expired" } } }));

    await expect(tokens.refreshChannel(fx.tenant.id, fx.instagram.id)).rejects.toThrow("Session has expired");
    expect((await secretsOf(fx.instagram.id)).accessToken).toBe("token-antigo");
    graph.resetReply();
  });
});
