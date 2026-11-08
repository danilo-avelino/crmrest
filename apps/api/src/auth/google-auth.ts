import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { Env } from "../config/env.js";

/**
 * "Continuar com Google": OAuth (código com PKCE) direto entre a API e o Google, sem o Supabase. O Google só prova de
 * quem é o e-mail; a conta continua sendo a nossa, e só entra quem já tem uma (cadastro pelo site ou convite).
 */
export type GoogleEnv = Env & { GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string };

export function hasGoogleAuth(env: Env): env is GoogleEnv {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/** Retorno cadastrado no Google: a API atrás do proxy /api do painel, como o do Instagram. */
function redirectUri(env: Env): string {
  return `${env.WEB_ORIGIN}/api/auth/google/callback`;
}

/**
 * Endereço da tela do Google e o que fica no cookie do navegador até a volta: o `state` (a volta só vale no navegador
 * que abriu o login), o verificador do PKCE e o `nonce` que o token do Google tem de trazer.
 */
export function googleLoginStart(env: GoogleEnv): { url: string; pending: string } {
  const [state, verifier, nonce] = [token(), token(), token()];
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(env),
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return { url: `${env.GOOGLE_AUTH_URL}?${params.toString()}`, pending: [state, verifier, nonce].join(".") };
}

export type GoogleCallback = { code?: string; state?: string; error?: string };

/**
 * Volta do Google: troca o código pelo token, confere a assinatura, o destinatário e o `nonce`, e devolve o e-mail
 * verificado da conta Google. null quando a volta não é deste navegador ou o Google não confirma o e-mail.
 */
export async function googleVerifiedEmail(env: GoogleEnv, query: GoogleCallback, pending: string | undefined): Promise<string | null> {
  const [state = "", verifier = "", nonce = ""] = (pending ?? "").split(".");
  if (!query.code || !query.state || !state || !safeEqual(query.state, state)) return null;

  const response = await fetch(env.GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: query.code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(env),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Google recusou o código: HTTP ${response.status} ${await response.text()}`);
  const { id_token } = z.object({ id_token: z.string() }).parse(await response.json());

  const { payload } = await jwtVerify(id_token, jwks(env.GOOGLE_JWKS_URL), {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: env.GOOGLE_CLIENT_ID,
  });
  const claims = z.object({ email: z.email(), email_verified: z.boolean(), nonce: z.string() }).safeParse(payload);
  if (!claims.success || !claims.data.email_verified || !safeEqual(claims.data.nonce, nonce)) return null;
  return claims.data.email;
}

// As chaves públicas do Google, guardadas (o jose renova quando elas mudam).
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwks(url: string) {
  let set = keySets.get(url);
  if (!set) keySets.set(url, (set = createRemoteJWKSet(new URL(url))));
  return set;
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && timingSafeEqual(x, y);
}
