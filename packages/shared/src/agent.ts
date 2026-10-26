import { z } from "zod";
import type { OnboardingDto } from "./onboarding.js";

// ---------- Agente de implantação e suporte na extensão do Chrome (E31) ----------

/**
 * Sites em que a IA age sem pedir permissão (o domínio e os subdomínios dele): o Dish Desk e os painéis de fora usados
 * na implantação. O endereço do painel (WEB_ORIGIN, ex.: localhost em dev) também vale. Outro site, só com a permissão
 * do parceiro na sessão.
 */
export const AGENT_HOSTS = ["dishdesk.com.br", "portal.ifood.com.br", "cardapioweb.com", "facebook.com", "instagram.com"];

export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const name = host.toLowerCase();
  return allowed.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

/** Campo que a IA nunca preenche: senha, código de verificação ou dado de cartão. */
export const SensitiveField = z.enum(["password", "code", "card"]);
export type SensitiveField = z.infer<typeof SensitiveField>;

/**
 * Um elemento da página, como a extensão lê: `ref` é o número que a IA usa para agir nele. `sensitive` vem da extensão
 * (tipo e autocomplete do campo); a API confere de novo pelo nome.
 */
export const PageElement = z.object({
  ref: z.number().int().nonnegative(),
  role: z.string().max(40),
  name: z.string().max(200),
  value: z.string().max(200).optional(),
  sensitive: SensitiveField.optional(),
  disabled: z.boolean().optional(),
  checked: z.boolean().optional(),
  options: z.array(z.string().max(100)).max(30).optional(),
});
export type PageElement = z.infer<typeof PageElement>;

export const PageSnapshot = z.object({
  url: z.url().max(2000),
  title: z.string().max(300),
  elements: z.array(PageElement).max(400),
  /** O texto visível da página, resumido pela extensão. */
  text: z.string().max(6000),
});
export type PageSnapshot = z.infer<typeof PageSnapshot>;

export const AgentSessionKind = z.enum(["SETUP", "SUPPORT"]);
export type AgentSessionKind = z.infer<typeof AgentSessionKind>;

export const StartAgentSessionRequest = z.object({ tenantId: z.uuid(), kind: AgentSessionKind });
export type StartAgentSessionRequest = z.infer<typeof StartAgentSessionRequest>;

/**
 * Uma volta do agente. A extensão manda a página atual e o que aconteceu desde a última resposta: a mensagem do
 * parceiro, o resultado da ação executada, a resposta a uma confirmação ou a um pedido de permissão.
 */
export const AgentTurnRequest = z.object({
  message: z.string().trim().min(1).max(2000).optional(),
  page: PageSnapshot.optional(),
  result: z.object({ ok: z.boolean(), error: z.string().max(500).optional() }).optional(),
  /** Resposta ao cartão "Confirmar ação": true = o parceiro confirmou e a extensão executou a ação. */
  confirmed: z.boolean().optional(),
  /** Resposta ao pedido de permissão de site: o host permitido (ou nada, se ele não permitiu). */
  granted: z.string().max(253).optional(),
});
export type AgentTurnRequest = z.infer<typeof AgentTurnRequest>;

/** Ação que a extensão executa sozinha e, depois, manda o resultado na próxima volta. */
export type AgentPageAction =
  | { type: "click"; ref: number; label: string }
  | { type: "fill"; ref: number; label: string; value: string }
  | { type: "select"; ref: number; label: string; value: string }
  | { type: "navigate"; url: string; newTab?: boolean }
  | { type: "switch"; host: string };

/**
 * O que a IA faz agora. `say` é o que ela diz ao parceiro no painel.
 * - `act`: executar a ação e voltar com o resultado;
 * - `confirm`: mostrar o cartão "Confirmar ação" (ação que não dá para desfazer ou fala em nome do restaurante);
 * - `your_turn`: o parceiro preenche (senha, código, cartão) e clica em "Pronto"; com `copy`, o painel mostra esse texto
 *   com o botão Copiar, para ele colar no campo (ex.: o código de vinculação do Dish Desk nas caixinhas do iFood);
 * - `login`: abrir o painel de fora (ex.: Portal do Parceiro do iFood) numa aba nova e esperar o parceiro entrar com o
 *   usuário e a senha dele e clicar em "Pronto";
 * - `permission`: pedir para agir num site fora da lista;
 * - `reply`: só responder e esperar o parceiro;
 * - `done`: o pedido terminou (na implantação, conferido pelo Dish Desk);
 * - `handoff`: passou para o suporte humano;
 * - `lost`: a IA se perdeu (a página mudou ou ela errou várias vezes): tentar de novo ou falar com o suporte;
 * - `unavailable`: a IA está fora do ar.
 */
export type AgentAction =
  | { type: "act"; say: string; action: AgentPageAction }
  | { type: "confirm"; say: string; action: AgentPageAction }
  | { type: "your_turn"; say: string; ref: number | null; field: SensitiveField; copy?: string }
  | { type: "login"; say: string; url: string }
  | { type: "permission"; say: string; host: string }
  | { type: "reply"; say: string }
  | { type: "done"; say: string }
  | { type: "handoff"; say: string; reason: string }
  | { type: "lost"; say: string }
  | { type: "unavailable"; say: string };

export type AgentSessionStatus = "ACTIVE" | "DONE" | "HANDED_OFF";

export type AgentTurnDto = {
  sessionId: string;
  status: AgentSessionStatus;
  next: AgentAction;
  /** Implantação: o progresso do assistente de configuração (E30), conferido no Dish Desk. */
  progress: OnboardingDto | null;
};

export type AgentSessionDto = { id: string; tenantId: string; kind: AgentSessionKind; status: AgentSessionStatus; createdAt: string };

/**
 * O registro da sessão: o que o parceiro pediu (`partner`), o que a IA respondeu (`agent`), o resultado das ações
 * (`result`) e, depois da transferência, o que a equipe do Dish Desk respondeu (`support`).
 */
export type AgentEventKind = "partner" | "agent" | "result" | "support";

/** Depois da transferência, o parceiro continua escrevendo no painel; a equipe do Dish Desk responde na mesma conversa. */
export const AgentMessageRequest = z.object({ text: z.string().trim().min(1).max(2000) });
export type AgentMessageRequest = z.infer<typeof AgentMessageRequest>;

/** Uma mensagem da conversa com o suporte: do parceiro ou de quem da equipe do Dish Desk respondeu (`author`). */
export type AgentSupportMessageDto = { id: string; from: "partner" | "support"; author: string | null; text: string; createdAt: string };

/** Horário do suporte humano do Dish Desk (Brasília): dias da semana (0 = domingo) e horas cheias de abertura e fechamento. */
export const SUPPORT_HOURS = { days: [1, 2, 3, 4, 5], open: 9, close: 18 } as const;

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** Fora do horário do suporte: quando ele volta ("amanhã às 9h", "segunda às 9h"); null com o suporte aberto. */
export function supportReturn(now: Date): string | null {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short", hour: "numeric", hourCycle: "h23" })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!);
  const hour = Number(parts.hour);
  const works = (weekday: number) => (SUPPORT_HOURS.days as readonly number[]).includes(weekday);
  if (works(day) && hour >= SUPPORT_HOURS.open && hour < SUPPORT_HOURS.close) return null;
  const at = `às ${SUPPORT_HOURS.open}h`;
  if (works(day) && hour < SUPPORT_HOURS.open) return `hoje ${at}`;
  for (let ahead = 1; ahead <= 7; ahead++) {
    const weekday = (day + ahead) % 7;
    if (works(weekday)) return `${ahead === 1 ? "amanhã" : WEEKDAYS[weekday]} ${at}`;
  }
  return null;
}
