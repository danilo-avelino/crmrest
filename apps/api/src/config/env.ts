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
  // WhatsApp por QR Code (Evolution API, serviço próprio): endereço e chave global da Evolution, o endereço em que ela
  // entrega os webhooks à API (/api/webhooks/evolution) e o token que ela manda neles. Sem os quatro, o botão fica desligado.
  EVOLUTION_API_URL: z.url().optional(),
  EVOLUTION_API_KEY: z.string().min(1).optional(),
  EVOLUTION_WEBHOOK_URL: z.url().optional(),
  EVOLUTION_WEBHOOK_TOKEN: z.string().min(16).optional(),
  INSTAGRAM_GRAPH_URL: z.url().default("https://graph.instagram.com/v24.0"),
  // iFood: credencial do aplicativo. Sem ela, o polling fica desligado.
  IFOOD_CLIENT_ID: z.string().min(1).optional(),
  IFOOD_CLIENT_SECRET: z.string().min(1).optional(),
  // Tipo do aplicativo no iFood. "centralized": a credencial vale para todas as lojas que autorizaram o app no Portal.
  // "distributed": cada loja autoriza pelo código de vinculação (Configurações → Integrações) e tem o próprio acesso.
  IFOOD_APP_TYPE: z.enum(["centralized", "distributed"]).default("centralized"),
  IFOOD_API_URL: z.url().default("https://merchant-api.ifood.com.br"),
  // Widget do iFood (chat com o cliente na Inbox): id do widget cadastrado no Portal do Desenvolvedor. Sem ele, não aparece.
  IFOOD_WIDGET_ID: z.string().min(1).optional(),
  // Trava do chat do iFood na Inbox: ligada, o painel copia o chat do widget (pela extensão do Chrome) e responde por ele.
  // Desligada, o Dish Desk só mostra o widget oficial, sem ler nem escrever nele.
  IFOOD_CHAT_BRIDGE: z.stringbool().default(false),
  // Ações do pedido do iFood (confirmar, pronto, despachar, cancelar, responder ao cancelamento do cliente). Desligada,
  // o Dish Desk só acompanha os pedidos: quem opera é o sistema de pedidos da loja. Ligar para a homologação do iFood.
  IFOOD_ORDER_ACTIONS: z.stringbool().default(false),
  // Página da extensão na Chrome Web Store: o painel sem a extensão mostra o botão "Instalar" com este endereço.
  IFOOD_EXTENSION_URL: z.url().optional(),
  // Cardápio Web: a chave de API é de cada loja (fica no canal); aqui só o endereço da API. Sem ele, o polling fica desligado.
  CARDAPIO_WEB_API_URL: z.url().optional(),
  // Stripe (assinatura depois do teste grátis). Sem a chave, o checkout e o webhook respondem 503; sem o segredo, o webhook também.
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_API_URL: z.url().default("https://api.stripe.com"),
  // Supabase Auth: só manda o e-mail de "Esqueceu a senha?" e confere o link de volta; o login continua sendo o nosso.
  // A chave é a secreta (service_role). Sem as duas, a recuperação de senha responde 503.
  SUPABASE_URL: z.url().optional(),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  // LLM do módulo Atendimento com IA, no formato da OpenAI (/chat/completions): o Ollama local do docker-compose
  // (http://localhost:11434/v1) ou um provedor. Sem o endereço, a IA fica desligada mesmo com o módulo ligado.
  AI_BASE_URL: z.url().optional(),
  AI_API_KEY: z.string().min(1).optional(),
  AI_MODEL: z.string().min(1).default("gemma4:12b"),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
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
