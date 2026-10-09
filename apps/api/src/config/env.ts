import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Papel do processo (§3.2). "all" roda todos os papéis num processo só (desenvolvimento).
  APP_ROLE: z.enum(["all", "api", "gateway", "realtime", "worker"]).default("all"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  JWT_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().min(1),
  // Origem do painel, para o CORS do Socket.IO (o REST passa pelo proxy /api do Next).
  WEB_ORIGIN: z.url().default("http://localhost:3000"),
  // Meta (WhatsApp/Instagram). Sem os segredos, o webhook responde 503.
  META_APP_SECRET: z.string().min(1).optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(1).optional(),
  // Os webhooks da API do Instagram com login do Instagram vêm assinados com o segredo do app do Instagram.
  INSTAGRAM_APP_SECRET: z.string().min(1).optional(),
  // Login do Instagram (Configurações → Integrações): id do app do Instagram e o endereço de retorno cadastrado nele.
  // Sem o retorno, vale WEB_ORIGIN + /api/integrations/instagram/callback (a API atrás do proxy do painel).
  INSTAGRAM_APP_ID: z.string().min(1).optional(),
  INSTAGRAM_REDIRECT_URI: z.url().optional(),
  INSTAGRAM_OAUTH_URL: z.url().default("https://api.instagram.com"),
  // Cadastro incorporado do WhatsApp: id do app da Meta e o id da configuração do "Login do Facebook para Empresas".
  META_APP_ID: z.string().min(1).optional(),
  META_EMBEDDED_SIGNUP_CONFIG_ID: z.string().min(1).optional(),
  META_GRAPH_URL: z.url().default("https://graph.facebook.com/v24.0"),
  INSTAGRAM_GRAPH_URL: z.url().default("https://graph.instagram.com/v24.0"),
  // iFood (modelo centralizado: uma credencial da plataforma para todas as lojas). Sem ela, o polling fica desligado.
  IFOOD_CLIENT_ID: z.string().min(1).optional(),
  IFOOD_CLIENT_SECRET: z.string().min(1).optional(),
  IFOOD_API_URL: z.url().default("https://merchant-api.ifood.com.br"),
  // Widget do iFood (chat com o cliente na Inbox): id do widget cadastrado no Portal do Desenvolvedor. Sem ele, não aparece.
  IFOOD_WIDGET_ID: z.string().min(1).optional(),
  // Cardápio Web: a chave de API é de cada loja (fica no canal); aqui só o endereço da API. Sem ele, o polling fica desligado.
  CARDAPIO_WEB_API_URL: z.url().optional(),
  // Desenvolvimento sem credenciais reais: envios aos canais são simulados (nunca em produção).
  CHANNELS_DRY_RUN: z.stringbool().default(false),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Painel das filas (Bull Board) em /api/admin/filas, com Basic auth. Sem senha, o painel não existe.
  BULL_BOARD_USER: z.string().min(1).default("admin"),
  BULL_BOARD_PASSWORD: z.string().min(12).optional(),
});

export type Env = z.infer<typeof EnvSchema>;
export type AppRole = Env["APP_ROLE"];

export const ENV = Symbol("ENV");

export function hasRole(env: Env, role: Exclude<AppRole, "all">): boolean {
  return env.APP_ROLE === "all" || env.APP_ROLE === role;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env = EnvSchema.parse(source);
  if (env.NODE_ENV === "production" && env.CHANNELS_DRY_RUN) {
    throw new Error("CHANNELS_DRY_RUN não pode ser usado em produção.");
  }
  return env;
}
