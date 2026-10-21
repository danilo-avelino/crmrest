import { Logger } from "@nestjs/common";
import { z } from "zod";
import type { Env } from "../config/env.js";

/**
 * Supabase Auth como carteiro da recuperação de senha. Os usuários e as senhas continuam na nossa tabela users: o
 * Supabase só guarda uma cópia do e-mail, manda o link e, na volta, diz de quem é o token que veio no link.
 */
const logger = new Logger("SupabaseAuth");

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

/**
 * Convite de usuário novo (Configurações → Usuários): o e-mail "Invite user" do Supabase, com o link para
 * /redefinir-senha, onde a pessoa cria a senha. Se o e-mail já tem cópia no Supabase (422), vai o de recuperação.
 */
export async function sendInviteEmail(env: SupabaseEnv, email: string): Promise<void> {
  const redirect = encodeURIComponent(`${env.WEB_ORIGIN}/redefinir-senha`);
  const invited = await supabase(env, "POST", `/invite?redirect_to=${redirect}`, { body: { email } });
  if (invited.status === 422) return sendRecoveryEmail(env, email);
  await ensureOk(invited, "invite");
}

/**
 * E-mail do dono do token que o link de recuperação (ou de convite) entregou ao painel; null se o Supabase não reconhece o token.
 * Um token válido prova que quem o tem recebeu o link no e-mail: o cadastro direto no Supabase fica desligado e as
 * cópias que a API cria não têm senha. (Não se exige a origem "recovery" no token: o link do e-mail pode emiti-lo
 * como "otp", e o painel recusava links válidos.) Depois de lido, o token é encerrado: o mesmo link não troca a senha duas vezes.
 */
export async function consumeRecoveryToken(env: SupabaseEnv, token: string): Promise<string | null> {
  const response = await supabase(env, "GET", "/user", { token });
  if (!response.ok) {
    logger.warn(`Token de recuperação recusado pelo Supabase: HTTP ${response.status} ${await response.text()}`);
    return null;
  }
  const user = z.object({ email: z.email() }).safeParse(await response.json());
  if (!user.success) {
    logger.warn("Token de recuperação sem e-mail no usuário do Supabase");
    return null;
  }
  // Sem o logout, o token ainda expira sozinho em 1 hora.
  await supabase(env, "POST", "/logout", { token }).catch(() => undefined);
  return user.data.email;
}
