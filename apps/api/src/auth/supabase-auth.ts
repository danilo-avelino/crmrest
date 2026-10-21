import { z } from "zod";
import type { Env } from "../config/env.js";

/**
 * Supabase Auth como carteiro da recuperação de senha. Os usuários e as senhas continuam na nossa tabela users: o
 * Supabase só guarda uma cópia do e-mail, manda o link e, na volta, diz de quem é o token que veio no link.
 */
export type SupabaseEnv = Env & { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string };

export function hasSupabaseAuth(env: Env): env is SupabaseEnv {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SECRET_KEY);
}

function supabase(env: SupabaseEnv, method: string, path: string, init: { body?: unknown; token?: string } = {}) {
  return fetch(`${env.SUPABASE_URL}/auth/v1${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${init.token ?? env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });
}

async function ensureOk(response: Response, what: string): Promise<void> {
  if (!response.ok) throw new Error(`Supabase Auth ${what}: HTTP ${response.status} ${await response.text()}`);
}

/** Cria a cópia do usuário no Supabase Auth (422 = já existe) e pede o e-mail com o link para /redefinir-senha. */
export async function sendRecoveryEmail(env: SupabaseEnv, email: string): Promise<void> {
  const created = await supabase(env, "POST", "/admin/users", { body: { email, email_confirm: true } });
  if (created.status !== 422) await ensureOk(created, "criar usuário");
  const redirect = encodeURIComponent(`${env.WEB_ORIGIN}/redefinir-senha`);
  await ensureOk(await supabase(env, "POST", `/recover?redirect_to=${redirect}`, { body: { email } }), "recover");
}

const Claims = z.object({ amr: z.array(z.object({ method: z.string() })).default([]) });

/**
 * E-mail do dono do token que o link de recuperação entregou ao painel; null se o token não vale ou não veio de um
 * link de recuperação (um token de outro tipo de login no Supabase não pode trocar a senha de ninguém).
 * Depois de lido, o token é encerrado: o mesmo link não troca a senha duas vezes.
 */
export async function consumeRecoveryToken(env: SupabaseEnv, token: string): Promise<string | null> {
  const response = await supabase(env, "GET", "/user", { token });
  if (!response.ok) return null;
  // O Supabase já validou o token acima; aqui só se lê como ele foi emitido.
  const claims = Claims.safeParse(decodeJwtPayload(token));
  if (!claims.success || !claims.data.amr.some((entry) => entry.method === "recovery")) return null;
  const user = z.object({ email: z.email() }).safeParse(await response.json());
  if (!user.success) return null;
  // Sem o logout, o token ainda expira sozinho em 1 hora.
  await supabase(env, "POST", "/logout", { token }).catch(() => undefined);
  return user.data.email;
}

function decodeJwtPayload(token: string): unknown {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
