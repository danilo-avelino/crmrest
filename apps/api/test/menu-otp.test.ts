import { encrypt, parseEncryptionKey } from "@dishdesk/database";
import { fillMessage, PERSONALITY_MESSAGES } from "@dishdesk/shared";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorsService } from "../src/connectors/connectors.service.js";
import { OTP_MAX_ATTEMPTS, OTP_TTL_MS, SESSION_COOKIE } from "../src/public/customer-auth.service.js";
import { admin, createAuthFixture, createTestApp } from "./helpers.js";

describe("Entrada do cliente no cardápio por código no WhatsApp (F3-05)", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let send: ReturnType<typeof vi.spyOn>;
  let ip = 0;
  const url = (slug: string, path: string) => `/api/public/menu/${slug}${path}`;
  // Cada teste com um IP próprio: o limite por IP não mistura os casos.
  const post = (slug: string, path: string, body: object, cookie?: string) => {
    const req = request(app.getHttpServer()).post(url(slug, path)).set("X-Real-IP", `10.0.0.${ip}`);
    return (cookie ? req.set("Cookie", cookie) : req).send(body);
  };
  const me = (slug: string, cookie?: string) => {
    const req = request(app.getHttpServer()).get(url(slug, "/me"));
    return cookie ? req.set("Cookie", cookie) : req;
  };
  const randomPhone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const lastCode = () => /\b(\d{6})\b/.exec(String(send.mock.lastCall?.[1]?.text))?.[1] ?? "";
  const cookieOf = (res: request.Response) => [res.headers["set-cookie"]].flat().find((c) => c?.startsWith(SESSION_COOKIE))!.split(";")[0]!;

  async function login(slug: string, phone: string) {
    await post(slug, "/otp/request", { phone }).expect(200);
    return cookieOf(await post(slug, "/otp/verify", { phone, code: lastCode() }).expect(200));
  }

  beforeAll(async () => {
    app = await createTestApp();
    fx = await createAuthFixture();
    const key = parseEncryptionKey(process.env.ENCRYPTION_KEY ?? "");
    for (const tenant of [fx.a, fx.b, fx.c]) {
      await admin.tenantModule.create({ data: { tenantId: tenant.id, module: "MENU" } });
      await admin.menu.create({ data: { tenantId: tenant.id, name: "Cardápio" } });
    }
    await admin.tenant.update({ where: { id: fx.a.id }, data: { settings: { personality: "direto" } } });
    // A e B com WhatsApp por QR Code; C só com a API oficial (não manda texto livre fora da janela de 24 h).
    for (const [tenant, instance] of [
      [fx.a, `inst-${randomUUID()}`],
      [fx.b, `inst-${randomUUID()}`],
      [fx.c, undefined],
    ] as const) {
      await admin.channel.create({
        data: {
          tenantId: tenant.id,
          type: "WHATSAPP",
          name: "WhatsApp",
          externalId: `wa-${randomUUID()}`,
          credentials: encrypt(JSON.stringify({ accessToken: "token", ...(instance && { instance }) }), key),
          status: "CONNECTED",
        },
      });
    }
    send = vi.spyOn(app.get(ConnectorsService).evolution, "send");
  });

  beforeEach(() => {
    ip++;
    send.mockClear();
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  it("R1 telefone sem código (OTP) não lê pedidos, endereços nem dados salvos", async () => {
    const phone = randomPhone();
    const contact = await admin.contact.create({ data: { tenantId: fx.a.id, phone, phoneSource: "channel", name: "Maria Segredo" } });
    await admin.contactAddress.create({ data: { tenantId: fx.a.id, contactId: contact.id, street: "Rua Escondida", city: "SP", state: "SP" } });
    const res = await me(fx.a.slug).expect(401);
    expect(JSON.stringify(res.body)).not.toMatch(/Maria|Escondida/);
    await me(fx.a.slug, `${SESSION_COOKIE}=token-inventado`).expect(401);
    // Pedir o código não abre nada; só o código certo abre.
    await post(fx.a.slug, "/otp/request", { phone }).expect(200);
    await me(fx.a.slug).expect(401);
    const cookie = cookieOf(await post(fx.a.slug, "/otp/verify", { phone, code: lastCode() }).expect(200));
    const body = (await me(fx.a.slug, cookie).expect(200)).body;
    expect(body).toMatchObject({ name: "Maria Segredo", phone, addresses: [{ street: "Rua Escondida" }], orders: [] });
    // R10 (parte do OTP): o endereço salvo só aparece com a sessão.
    await post(fx.a.slug, "/logout", {}, cookie).expect(204);
    await me(fx.a.slug, cookie).expect(401);
  });

  it("a mensagem usa o texto da personalidade do restaurante e vai pelo WhatsApp por QR Code", async () => {
    const phone = randomPhone();
    const res = await post(fx.a.slug, "/otp/request", { phone }).expect(200);
    expect(res.body).toEqual({ available: true, expiresInSeconds: 600, resendInSeconds: 45 });
    expect(send).toHaveBeenCalledTimes(1);
    const [target, message] = send.mock.lastCall!;
    expect(target.recipientId).toBe(phone.slice(1));
    expect(message.text).toBe(fillMessage(PERSONALITY_MESSAGES.direto.menuLoginCode, { codigo: lastCode(), loja: fx.a.name }));
  });

  it("telefone conhecido e desconhecido recebem a mesma resposta", async () => {
    const known = randomPhone();
    await admin.contact.create({ data: { tenantId: fx.a.id, phone: known, phoneSource: "channel" } });
    const a = await post(fx.a.slug, "/otp/request", { phone: known }).expect(200);
    const b = await post(fx.a.slug, "/otp/request", { phone: randomPhone() }).expect(200);
    expect(a.body).toEqual(b.body);
  });

  it("sem WhatsApp por QR Code conectado responde available:false e não envia", async () => {
    const res = await post(fx.c.slug, "/otp/request", { phone: randomPhone() }).expect(200);
    expect(res.body).toEqual({ available: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("código errado: depois de 5 tentativas nem o certo entra", async () => {
    const phone = randomPhone();
    await post(fx.a.slug, "/otp/request", { phone }).expect(200);
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) await post(fx.a.slug, "/otp/verify", { phone, code: wrong }).expect(400);
    await post(fx.a.slug, "/otp/verify", { phone, code }).expect(400);
  });

  it("código vencido (10 min) não entra; reenvio só depois de 45 s", async () => {
    const phone = randomPhone();
    await post(fx.a.slug, "/otp/request", { phone }).expect(200);
    const res = await post(fx.a.slug, "/otp/request", { phone }).expect(429);
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(send).toHaveBeenCalledTimes(1);
    // O vencimento fica no Redis: o teste encurta a validade da chave em vez de esperar 10 min.
    const code = lastCode();
    const { Redis } = await import("ioredis");
    const redis = new Redis(process.env.REDIS_URL ?? "");
    const [key] = await redis.keys(`*menu-otp:code:${fx.a.id}:${phone}`);
    expect(await redis.pttl(key!)).toBeLessThanOrEqual(OTP_TTL_MS);
    await redis.pexpire(key!, 1);
    await redis.quit();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await post(fx.a.slug, "/otp/verify", { phone, code }).expect(400);
  });

  it("sessão do restaurante A no cardápio de B: 401", async () => {
    const phone = randomPhone();
    const cookie = await login(fx.a.slug, phone);
    await me(fx.a.slug, cookie).expect(200);
    await me(fx.b.slug, cookie).expect(401);
  });

  it("cria o cadastro no primeiro acesso; consentimento de marketing só com true", async () => {
    const phone = randomPhone();
    await post(fx.a.slug, "/otp/request", { phone }).expect(200);
    await post(fx.a.slug, "/otp/verify", { phone, code: lastCode(), name: "Novo Cliente" }).expect(200);
    const contact = await admin.contact.findFirstOrThrow({ where: { tenantId: fx.a.id, phone }, include: { consents: true } });
    expect(contact).toMatchObject({ name: "Novo Cliente", phoneSource: "channel", consents: [] });

    const other = randomPhone();
    await post(fx.a.slug, "/otp/request", { phone: other }).expect(200);
    await post(fx.a.slug, "/otp/verify", { phone: other, code: lastCode(), marketingOptIn: true }).expect(200);
    const consents = await admin.consent.findMany({ where: { contact: { tenantId: fx.a.id, phone: other } } });
    expect(consents).toMatchObject([{ purpose: "marketing_whatsapp", granted: true }]);
  });
});
