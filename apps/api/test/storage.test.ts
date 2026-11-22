import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/config/env.js";
import { StorageService } from "../src/storage/storage.service.js";
import { accessTokenFor, admin, createAuthFixture, createTestApp } from "./helpers.js";

const SUPA = "https://proj.supabase.co";
const TENANT = "11111111-2222-4333-8444-555555555555";
const KEY_RE = new RegExp(`^tenants/${TENANT}/photo/[0-9a-f-]{36}\\.png$`);

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
const calls: Call[] = [];
const realFetch = globalThis.fetch;

function mockFetch() {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.startsWith(SUPA)) return realFetch(input, init);
    calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body });
    if (url.includes("/object/sign/")) return new Response(JSON.stringify({ signedURL: "/object/sign/menu-private/x?token=abc" }), { status: 200 });
    return new Response("{}", { status: 200 });
  });
}

describe("StorageService (F0-03)", () => {
  const storage = new StorageService({ SUPABASE_URL: SUPA, SUPABASE_SECRET_KEY: "sk" } as Env);
  beforeAll(mockFetch);
  afterEach(() => void calls.splice(0));
  afterAll(() => vi.unstubAllGlobals());

  it("grava foto com a chave do restaurante no bucket público", async () => {
    const { key, publicUrl } = await storage.put(TENANT, "photo", new Uint8Array([1, 2, 3]), "image/png");
    expect(key).toMatch(KEY_RE);
    expect(publicUrl).toBe(`${SUPA}/storage/v1/object/public/menu-public/${key}`);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${SUPA}/storage/v1/object/menu-public/${key}` });
    expect(calls[0]!.headers["Content-Type"]).toBe("image/png");
  });

  it("áudio vai para o privado, sem URL pública; URL assinada pelo TTL", async () => {
    const { key, publicUrl } = await storage.put(TENANT, "audio", new Uint8Array([1]), "audio/ogg; codecs=opus");
    expect(key).toMatch(new RegExp(`^tenants/${TENANT}/audio/.+\\.ogg$`));
    expect(publicUrl).toBeNull();
    expect(calls[0]!.url).toContain("/object/menu-private/");
    const signed = await storage.signedUrl(key, 600);
    expect(signed).toBe(`${SUPA}/storage/v1/object/sign/menu-private/x?token=abc`);
    expect(calls[1]).toMatchObject({ method: "POST", url: `${SUPA}/storage/v1/object/sign/menu-private/${key}`, body: '{"expiresIn":600}' });
  });

  it("recusa MIME fora da lista e tamanho acima do limite, sem chamar o Supabase", async () => {
    await expect(storage.put(TENANT, "photo", new Uint8Array([1]), "image/gif")).rejects.toThrow(/Formato/);
    await expect(storage.put(TENANT, "qr", new Uint8Array([1]), "image/jpeg")).rejects.toThrow(/Formato/);
    await expect(storage.put(TENANT, "qr", new Uint8Array(1024 * 1024 + 1), "image/png")).rejects.toThrow(/grande/);
    await expect(storage.put(TENANT, "photo", new Uint8Array(1024 * 1024 + 1), "image/webp")).rejects.toThrow("A imagem passa de 1 MB. Use uma imagem menor.");
    await expect(storage.put(TENANT, "logo", new Uint8Array(1024 * 1024 + 1), "image/png")).rejects.toThrow("A imagem passa de 1 MB. Use uma imagem menor.");
    await expect(storage.put(TENANT, "photo", new Uint8Array(0), "image/png")).rejects.toThrow(/grande/);
    expect(calls).toHaveLength(0);
  });

  it("aceita foto de exatamente 1 MB", async () => {
    await expect(storage.put(TENANT, "photo", new Uint8Array(1024 * 1024), "image/webp")).resolves.toMatchObject({ publicUrl: expect.any(String) });
  });

  it("recusa path traversal e restaurante fora do formato", async () => {
    await expect(storage.put("../x", "photo", new Uint8Array([1]), "image/png")).rejects.toThrow();
    await expect(storage.signedUrl(`tenants/${TENANT}/audio/../../outro/a.ogg`, 60)).rejects.toThrow(/inválida/);
    await expect(storage.signedUrl("menu-private/qualquer.png", 60)).rejects.toThrow(/inválida/);
    const other = "99999999-2222-4333-8444-555555555555";
    await expect(storage.delete(TENANT, `tenants/${other}/photo/${TENANT}.png`)).rejects.toThrow(/outro restaurante/);
    expect(calls).toHaveLength(0);
  });

  it("delete chama o bucket certo", async () => {
    const key = `tenants/${TENANT}/qr/${TENANT}.png`;
    await storage.delete(TENANT, key);
    expect(calls[0]).toMatchObject({ method: "DELETE", url: `${SUPA}/storage/v1/object/menu-private/${key}` });
  });
});

describe("PUT /menu/:tenantId/items/:id/photo", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let adminToken: string;
  let agentToken: string;
  let itemId: string;

  beforeAll(async () => {
    mockFetch();
    app = await createTestApp({ SUPABASE_URL: SUPA, SUPABASE_SECRET_KEY: "sk" });
    fx = await createAuthFixture();
    adminToken = await accessTokenFor(app, fx.user.email, fx.b.id);
    agentToken = await accessTokenFor(app, fx.user.email, fx.a.id);
    for (const t of [fx.a.id, fx.b.id]) await admin.tenantModule.create({ data: { tenantId: t, module: "MENU" } });
    const http = () => request(app.getHttpServer());
    const cat = (await http().post(`/api/menu/${fx.b.id}/categories`).set("Authorization", `Bearer ${adminToken}`).send({ name: "Pizzas" }).expect(201)).body;
    itemId = (await http().post(`/api/menu/${fx.b.id}/items`).set("Authorization", `Bearer ${adminToken}`).send({ categoryId: cat.id, name: "Margherita", priceCents: 4000 }).expect(201)).body.id;
  });

  afterEach(() => void calls.splice(0));
  afterAll(async () => {
    vi.unstubAllGlobals();
    await fx?.cleanup();
    await app?.close();
  });

  const put = (tenantId: string, id: string, token: string, mime: string, body: Buffer) =>
    request(app.getHttpServer()).put(`/api/menu/${tenantId}/items/${id}/photo`).set("Authorization", `Bearer ${token}`).set("Content-Type", mime).send(body);

  it("grava a foto e troca o photoUrl; a anterior é apagada", async () => {
    const first = (await put(fx.b.id, itemId, adminToken, "image/jpeg", Buffer.from([1, 2, 3])).expect(200)).body;
    expect(first.photoUrl).toMatch(new RegExp(`^${SUPA}/storage/v1/object/public/menu-public/tenants/${fx.b.id}/photo/[0-9a-f-]{36}\\.jpg$`));
    const row = await admin.menuItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.photoUrl).toBe(first.photoUrl);

    calls.splice(0);
    const second = (await put(fx.b.id, itemId, adminToken, "image/png", Buffer.from([4])).expect(200)).body;
    expect(second.photoUrl).not.toBe(first.photoUrl);
    expect(calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
    expect(calls[1]!.url).toBe(first.photoUrl.replace("/object/public/", "/object/"));
  });

  it("atendente, outro restaurante e formato errado não gravam nada", async () => {
    await put(fx.a.id, itemId, agentToken, "image/png", Buffer.from([1])).expect(403);
    await put(fx.b.id, itemId, agentToken, "image/png", Buffer.from([1])).expect(403);
    await put(fx.b.id, itemId, adminToken, "image/gif", Buffer.from([1])).expect(400);
    await put(fx.b.id, itemId, adminToken, "image/png", Buffer.alloc(5 * 1024 * 1024 + 1)).expect(400);
    expect(calls).toHaveLength(0);
  });
});

describe("StorageService em disco local (dev)", () => {
  const WEB = "http://localhost:3000";
  const ENC = Buffer.alloc(32, 7).toString("base64");
  let dir: string;
  let storage: StorageService;
  const envOf = (extra: Partial<Env> = {}) => ({ NODE_ENV: "development", WEB_ORIGIN: WEB, ENCRYPTION_KEY: ENC, STORAGE_LOCAL_DIR: dir, ...extra }) as Env;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dd-storage-"));
    storage = new StorageService(envOf());
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it("put/get/delete no disco e publicUrl da API", async () => {
    const { key, publicUrl } = await storage.put(TENANT, "photo", new Uint8Array([1, 2, 3]), "image/png");
    expect(key).toMatch(KEY_RE);
    expect(publicUrl).toBe(`${WEB}/api/storage/menu-public/${key}`);
    expect(storage.keyFromPublicUrl(publicUrl)).toBe(key);
    expect(Array.from(await readFile(path.join(dir, "menu-public", ...key.split("/"))))).toEqual([1, 2, 3]);
    await storage.delete(TENANT, key);
    await expect(storage.get(TENANT, key)).rejects.toThrow(/não encontrado/);
  });

  it("mesmas regras de tipo, tamanho e chave", async () => {
    await expect(storage.put(TENANT, "photo", new Uint8Array([1]), "image/gif")).rejects.toThrow(/Formato/);
    await expect(storage.put(TENANT, "photo", new Uint8Array(1024 * 1024 + 1), "image/png")).rejects.toThrow("A imagem passa de 1 MB. Use uma imagem menor.");
    await expect(storage.put(TENANT, "photo", new Uint8Array(0), "image/png")).rejects.toThrow(/grande/);
    await expect(storage.put("../x", "photo", new Uint8Array([1]), "image/png")).rejects.toThrow();
    await expect(storage.signedUrl(`tenants/${TENANT}/audio/../../outro/a.ogg`, 60)).rejects.toThrow(/inválida/);
    await expect(storage.localRead("menu-public", `tenants/${TENANT}/photo/../../x.png`)).rejects.toThrow(/inválida/);
  });

  it("URL assinada: válida, expirada e adulterada", async () => {
    const { key } = await storage.put(TENANT, "audio", new Uint8Array([9]), "audio/ogg");
    const url = new URL(await storage.signedUrl(key, 600));
    expect(url.pathname).toBe(`/api/storage/menu-private/${key}`);
    const exp = url.searchParams.get("exp")!;
    const sig = url.searchParams.get("sig")!;
    await expect(storage.localRead("menu-private", key, exp, sig)).resolves.toMatchObject({ mime: "audio/ogg", isPublic: false });
    await expect(storage.localRead("menu-private", key, exp, `${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}`)).rejects.toThrow(/inválido/);
    await expect(storage.localRead("menu-private", key, String(Number(exp) + 1), sig)).rejects.toThrow(/inválido/);
    await expect(storage.localRead("menu-private", key)).rejects.toThrow(/inválido/);
    const expired = new URL(await storage.signedUrl(key, -10));
    await expect(storage.localRead("menu-private", key, expired.searchParams.get("exp")!, expired.searchParams.get("sig")!)).rejects.toThrow(/inválido/);
    await expect(storage.localRead("menu-public", key)).rejects.toThrow();
  });

  it("produção sem as chaves continua 503 e não grava em disco", async () => {
    const prod = new StorageService(envOf({ NODE_ENV: "production" }));
    await expect(prod.put(TENANT, "photo", new Uint8Array([1]), "image/png")).rejects.toThrow("Storage não configurado");
    await expect(prod.localRead("menu-public", `tenants/${TENANT}/photo/${TENANT}.png`)).rejects.toThrow();
  });

  describe("GET /storage/:bucket/...", () => {
    let app: INestApplication;
    const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY };
    beforeAll(async () => {
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SECRET_KEY;
      app = await createTestApp({ STORAGE_LOCAL_DIR: dir, NODE_ENV: "development" });
    });
    afterAll(async () => {
      if (saved.url !== undefined) process.env.SUPABASE_URL = saved.url;
      if (saved.key !== undefined) process.env.SUPABASE_SECRET_KEY = saved.key;
      await app?.close();
    });

    it("serve a foto pública sem login, com Content-Type e cache", async () => {
      const { key } = await new StorageService({ ...envOf() }).put(TENANT, "photo", new Uint8Array([1, 2, 3]), "image/webp");
      const res = await request(app.getHttpServer()).get(`/api/storage/menu-public/${key}`).expect(200);
      expect(res.headers["content-type"]).toContain("image/webp");
      expect(res.headers["cache-control"]).toContain("public");
      await request(app.getHttpServer()).get(`/api/storage/menu-private/${key}`).expect(404);
    });
  });
});
