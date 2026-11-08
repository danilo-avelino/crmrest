import { createHash } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthFixture, createTestApp, startMockGraph } from "./helpers.js";

const CLIENT_ID = "dishdesk-teste.apps.googleusercontent.com";
const WEB = "http://localhost:3000";

describe("login com Google", () => {
  let app: INestApplication;
  let fx: Awaited<ReturnType<typeof createAuthFixture>>;
  let google: Awaited<ReturnType<typeof startMockGraph>>;
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  // O token que o Google falso devolve na próxima troca de código, e o nonce que o último login mandou ao Google.
  let idToken = "";
  let pendingNonce = "";

  beforeAll(async () => {
    keys = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: "chave-1", alg: "RS256", use: "sig" };
    google = await startMockGraph();
    google.reply((req) => {
      if (req.path.startsWith("/certs")) return { status: 200, body: { keys: [jwk] } };
      return { status: 200, body: { id_token: idToken, access_token: "x", token_type: "Bearer" } };
    });
    [app, fx] = await Promise.all([
      createTestApp({
        WEB_ORIGIN: WEB,
        GOOGLE_CLIENT_ID: CLIENT_ID,
        GOOGLE_CLIENT_SECRET: "segredo",
        GOOGLE_AUTH_URL: `${google.url}/auth`,
        GOOGLE_TOKEN_URL: `${google.url}/token`,
        GOOGLE_JWKS_URL: `${google.url}/certs`,
      }),
      createAuthFixture(),
    ]);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
    await google?.close();
  });

  beforeEach(() => {
    google.requests.length = 0;
  });

  type Claims = { email: string; email_verified: boolean; nonce?: string; aud?: string };
  const sign = async (claims: Claims) => {
    idToken = await new SignJWT({ email: claims.email, email_verified: claims.email_verified, nonce: claims.nonce ?? pendingNonce })
      .setProtectedHeader({ alg: "RS256", kid: "chave-1" })
      .setIssuer("https://accounts.google.com")
      .setAudience(claims.aud ?? CLIENT_ID)
      .setSubject("1234567890")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
  };

  /** Abre o login com Google no navegador do agente; devolve o state e o desafio do PKCE que foram ao Google. */
  const start = async (agent: ReturnType<typeof request.agent>) => {
    const response = await agent.get("/api/auth/google").expect(302);
    const url = new URL(response.headers.location!);
    expect(url.origin + url.pathname).toBe(`${google.url}/auth`);
    pendingNonce = url.searchParams.get("nonce")!;
    return { url, state: url.searchParams.get("state")! };
  };

  const login = async (claims: Claims) => {
    const agent = request.agent(app.getHttpServer());
    const { url, state } = await start(agent);
    await sign(claims);
    const back = await agent.get(`/api/auth/google/callback?code=codigo-do-google&state=${state}`).expect(302);
    return { agent, url, location: back.headers.location!, cookies: [back.headers["set-cookie"] ?? []].flat() };
  };

  it("leva ao Google com o retorno pelo painel, PKCE, nonce e a escolha de conta", async () => {
    const { url } = await start(request.agent(app.getHttpServer()));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: `${WEB}/api/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      code_challenge_method: "S256",
      prompt: "select_account",
    });
  });

  it("conta Google com o e-mail de um usuário: abre a sessão e volta para a escolha do restaurante", async () => {
    const { agent, url, location } = await login({ email: fx.user.email.toUpperCase(), email_verified: true });
    expect(location).toBe(`${WEB}/login`);

    // A troca do código levou o verificador do PKCE que corresponde ao desafio.
    const form = new URLSearchParams(google.requests.find((req) => req.path === "/token")!.body as string);
    expect(form.get("code")).toBe("codigo-do-google");
    expect(form.get("redirect_uri")).toBe(`${WEB}/api/auth/google/callback`);
    expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(url.searchParams.get("code_challenge"));

    const session = await agent.post("/api/auth/refresh").expect(200);
    expect(session.body.user.email).toBe(fx.user.email);
    expect(session.body.tenants.map((t: { id: string }) => t.id)).toContain(fx.a.id);
  });

  it("e-mail sem conta no Dish Desk: não cria conta nem sessão", async () => {
    const { location, cookies } = await login({ email: "ninguem-google@teste.local", email_verified: true });
    expect(location).toBe(`${WEB}/login?google=sem-conta`);
    expect(cookies.some((cookie) => cookie.startsWith("dishdesk_session="))).toBe(false);
  });

  it("e-mail não verificado pelo Google, nonce ou destinatário de outro login: não entra", async () => {
    for (const claims of [
      { email: fx.user.email, email_verified: false },
      { email: fx.user.email, email_verified: true, nonce: "outro" },
      { email: fx.user.email, email_verified: true, aud: "outro-app.apps.googleusercontent.com" },
    ]) {
      const { location, cookies } = await login(claims);
      expect(location).toBe(`${WEB}/login?google=erro`);
      expect(cookies.some((cookie) => cookie.startsWith("dishdesk_session="))).toBe(false);
    }
  });

  it("volta em outro navegador (sem o cookie) ou com outro state: nem chega a trocar o código", async () => {
    const agent = request.agent(app.getHttpServer());
    const { state } = await start(agent);
    const elsewhere = await request(app.getHttpServer()).get(`/api/auth/google/callback?code=c&state=${state}`).expect(302);
    expect(elsewhere.headers.location).toBe(`${WEB}/login?google=erro`);
    const forged = await agent.get("/api/auth/google/callback?code=c&state=outro").expect(302);
    expect(forged.headers.location).toBe(`${WEB}/login?google=erro`);
    expect(google.requests.some((req) => req.path === "/token")).toBe(false);
  });

  it("cancelado na tela do Google: volta ao login com o aviso", async () => {
    const agent = request.agent(app.getHttpServer());
    await start(agent);
    const back = await agent.get("/api/auth/google/callback?error=access_denied").expect(302);
    expect(back.headers.location).toBe(`${WEB}/login?google=cancelado`);
  });

  it("sem o cliente OAuth configurado, o botão volta com o aviso de indisponível", async () => {
    const without = await createTestApp({ WEB_ORIGIN: WEB });
    try {
      const response = await request(without.getHttpServer()).get("/api/auth/google").expect(302);
      expect(response.headers.location).toBe(`${WEB}/login?google=indisponivel`);
    } finally {
      await without.close();
    }
  });
});
