import type { Prisma, TenantTx } from "@dishdesk/database";
import {
  AGENT_HOSTS,
  type AgentAction,
  type AgentEventKind,
  type AgentSessionDto,
  type AgentSessionKind,
  type AgentSupportMessageDto,
  type AgentTurnDto,
  type AgentTurnRequest,
  ONBOARDING_STEPS,
  type OnboardingDto,
  type OnboardingStep,
  type PageSnapshot,
} from "@dishdesk/shared";
import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { z } from "zod";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { LlmClient } from "../ai/llm.client.js";
import { onboardingOf } from "../settings/onboarding.service.js";
import { isTenantAdmin } from "../settings/tenant-admin.js";
import { type Decision, guard } from "./agent-guard.js";
import { GUIDE, STEP_LABEL } from "./guide.js";

/** Ações seguidas que falharam até a IA parar ("se perdeu"). */
export const MAX_FAILURES = 3;
/** Eventos da sessão que a IA relê a cada volta (os mais recentes). */
const HISTORY_LIMIT = 12;
/** A árvore da página divide o contexto da LLM (8k no Ollama) com o guia e o histórico. */
const ELEMENTS_CHARS = 3500;
const TEXT_CHARS = 1200;
/** O texto de cada página guardado na sessão (para o que a IA pode preencher depois). */
const SEEN_CHARS = 2000;

export const AgentDecision = z.object({
  say: z.string().trim().min(1).max(400).describe("O que você diz ao parceiro, curto."),
  action: z.enum(["click", "fill", "select", "navigate", "reply", "done", "handoff"]),
  ref: z.number().int().min(0).describe("O número [ref] do elemento da PÁGINA; 0 quando a ação não usa elemento."),
  value: z.string().max(500).describe('fill e select: o texto ou a opção; navigate: o endereço; senão, "".'),
  irreversible: z.boolean().describe("A ação não dá para desfazer ou fala em nome do restaurante."),
  step: z.enum([...ONBOARDING_STEPS, "none"]).describe('done na implantação: o passo do PROGRESSO que terminou; senão, "none".'),
  reason: z.string().max(200).describe('handoff: por que passou para o suporte; senão, "".'),
});
type AgentDecision = z.infer<typeof AgentDecision>;

export function systemPrompt(restaurant: string, kind: AgentSessionKind, panel: string): string {
  const task =
    kind === "SETUP"
      ? "implantar o Dish Desk no restaurante, seguindo a ordem do GUIA. Antes de cada integração, pergunte se o restaurante usa aquele sistema; o PROGRESSO diz o que já está feito, pulado ou em andamento. Quando um passo aparecer como feito no PROGRESSO, use action = done com o step dele."
      : "tirar dúvidas sobre o Dish Desk e resolver problemas (canal desconectado, mensagem que não chegou, configuração errada), investigando na tela dele. Quando o problema estiver resolvido, use action = done.";
  return `Você é o assistente do Dish Desk dentro da extensão do Chrome e ajuda o parceiro (o dono ou o gerente do restaurante ${restaurant}) a ${task}
O painel do Dish Desk fica em ${panel} (as telas do GUIA ficam nele).
Você vê a página aberta no navegador dele (PÁGINA) e faz uma ação por vez nela: click, fill (preencher um campo), select (escolher uma opção) ou navigate (abrir um endereço). Depois de cada ação, você recebe a página de novo.

Regras obrigatórias:
- Use só os elementos da PÁGINA, pelo número [ref]. Se o que você procura não está nela, navegue até a tela certa.
- Só afirme o que está no GUIA, no PROGRESSO e na PÁGINA. Sem a informação, passe para o suporte (handoff).
- Nunca preencha senha, código de verificação nem dados de cartão, e nunca peça esses dados na conversa: o parceiro digita direto na página.
- irreversible = true em toda ação que não dá para desfazer ou que fala em nome do restaurante: aceitar termos, enviar documentos, publicar, pagar, apagar, desconectar.
- Passe para o suporte humano (handoff) quando o parceiro pedir, quando o assunto for cobrança, pagamento ou conta, ou quando você não souber resolver.
- Nunca invente o que preencher (usuário, e-mail, nome, chave): use só o que o parceiro disse ou o que apareceu na PÁGINA. Sem isso, pergunte a ele (reply).
- Se o parceiro já pediu uma integração, ele usa aquele sistema: não pergunte de novo.
- Se o parceiro só fez uma pergunta ou você precisa de uma resposta dele, use reply e espere.
- say: em português do Brasil, uma ou duas frases curtas, dizendo o que vai fazer (ex.: "Vou abrir Configurações → Integrações.").

${GUIDE}`;
}

/** A página como a LLM lê: um elemento por linha, com o número, o papel e o nome (cortada no limite do contexto). */
export function pageText(page: PageSnapshot | undefined): string {
  if (!page) return "PÁGINA\nNenhuma página aberta.";
  const lines: string[] = [];
  let size = 0;
  for (const element of page.elements) {
    const extra = [
      element.value ? `valor "${element.sensitive ? "***" : element.value}"` : null,
      element.checked !== undefined ? (element.checked ? "marcado" : "desmarcado") : null,
      element.disabled ? "desabilitado" : null,
      element.options?.length ? `opções: ${element.options.join(" | ")}` : null,
    ].filter(Boolean);
    const line = `[${element.ref}] ${element.role} "${element.name}"${extra.length ? ` (${extra.join(", ")})` : ""}`;
    if (size + line.length > ELEMENTS_CHARS) {
      lines.push(`… mais ${page.elements.length - lines.length} elementos (role a página para ver)`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return `PÁGINA\nEndereço: ${page.url}\nTítulo: ${page.title}\nElementos:\n${lines.join("\n") || "nenhum"}\nTexto: ${page.text.slice(0, TEXT_CHARS)}`;
}

/** Integração que o parceiro citou: ele usa o sistema (o Gemma segue melhor a instrução no dado do que uma regra condicional). */
const ASKED: Partial<Record<OnboardingStep, RegExp>> = {
  whatsapp: /whats|zap/i,
  instagram: /insta/i,
  ifood: /ifood/i,
  cardapio_web: /card[aá]pio\s*web/i,
};

export function progressText(progress: OnboardingDto | null, partner: string[] = []): string {
  if (!progress) return "";
  const status = { todo: "a fazer", done: "feito", skipped: "pulado", in_progress: "em andamento", error: "com erro" };
  const lines = progress.steps.map((item) => {
    const asked = item.status === "todo" && partner.some((text) => ASKED[item.step]?.test(text));
    const note = asked ? " (o parceiro pediu: ele usa, não pergunte; siga o passo a passo)" : "";
    return `- ${item.step} (${STEP_LABEL[item.step]}): ${status[item.status]}${item.detail ? `, ${item.detail}` : ""}${note}`;
  });
  return `PROGRESSO (conferido no Dish Desk)\n${lines.join("\n")}\n\n`;
}

type EventRow = { kind: string; content: Prisma.JsonValue };

/** O histórico da sessão para a LLM: o que o parceiro pediu, o que a IA disse e fez e o resultado. */
export function historyText(events: EventRow[]): string {
  const lines = events.map(({ kind, content }) => {
    const value = content as Record<string, unknown>;
    if (kind === "partner") return `Parceiro: ${String(value.text)}`;
    if (kind === "result") return `Resultado: ${String(value.summary)}`;
    const next = value.next as AgentAction;
    const action = "action" in next ? ` (${describe(next.action)})` : "";
    return `Você: ${next.say}${action}`;
  });
  return `HISTÓRICO\n${lines.join("\n") || "início da sessão"}`;
}

function describe(action: { type: string; ref?: number; label?: string; value?: string; url?: string }): string {
  if (action.type === "navigate") return `navigate ${action.url}`;
  return `${action.type} [${action.ref}] "${action.label}"${action.value ? ` = "${action.value}"` : ""}`;
}

/**
 * Agente de implantação e suporte na extensão do Chrome (E31). A extensão manda a página e o que aconteceu; a LLM
 * decide uma ação; as travas (agent-guard) garantem as regras; tudo fica registrado na sessão, para o suporte humano
 * continuar de onde a IA parou. Na implantação, um passo só termina com a conferência do Dish Desk (o progresso do E30).
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly llm: LlmClient,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async start(auth: RequestAuth, tenantId: string, kind: AgentSessionKind): Promise<AgentSessionDto> {
    if (!auth.scope.tenantIds.includes(tenantId)) throw new ForbiddenException("Sem acesso a este restaurante.");
    if (kind === "SETUP" && !isTenantAdmin(auth, tenantId)) throw new ForbiddenException("Só o administrador do restaurante faz a implantação.");
    const session = await this.db.withTenants({ tenantIds: [tenantId], userId: auth.userId }, (tx) =>
      tx.agentSession.create({ data: { tenantId, userId: auth.userId, kind, grantedHosts: [] } }),
    );
    return { id: session.id, tenantId, kind, status: session.status, createdAt: session.createdAt.toISOString() };
  }

  async turn(auth: RequestAuth, sessionId: string, body: AgentTurnRequest): Promise<AgentTurnDto> {
    const scope = { tenantIds: auth.scope.tenantIds, userId: auth.userId };
    const context = await this.db.withTenants(scope, async (tx) => {
      const session = await this.requireSession(tx, auth, sessionId);
      // O texto da página fica no evento da volta: o que apareceu nela (ex.: o código de autorização do iFood) pode ser
      // preenchido depois, em outra página.
      const seen = body.page ? { seen: body.page.text.slice(0, SEEN_CHARS) } : {};
      if (body.message) await event(tx, session, "partner", { text: body.message, ...seen });
      const summary = resultSummary(body);
      if (summary) {
        const result = JSON.parse(JSON.stringify({ summary, ...body.result, confirmed: body.confirmed, granted: body.granted }));
        await event(tx, session, "result", { ...result, ...(!body.message && seen) });
      }
      // Uma mensagem do parceiro (ex.: "tente de novo") recomeça a contagem; uma ação que falhou soma.
      const failures = body.message || body.result?.ok ? 0 : body.result ? session.failures + 1 : session.failures;
      const grantedHosts = body.granted && !session.grantedHosts.includes(body.granted) ? [...session.grantedHosts, body.granted] : session.grantedHosts;
      const updated = await tx.agentSession.update({ where: { id: session.id }, data: { failures, grantedHosts } });
      const events = (await tx.agentEvent.findMany({ where: { sessionId }, orderBy: { createdAt: "desc" }, take: HISTORY_LIMIT })).reverse();
      const progress = session.kind === "SETUP" ? await onboardingOf(tx, session.tenantId) : null;
      return { session: updated, restaurant: session.tenant.name, events, progress };
    });
    const { session, progress } = context;

    let next: AgentAction;
    let finished: { status: "DONE" | "HANDED_OFF"; reason?: string } | null = null;
    if (session.failures >= MAX_FAILURES) {
      next = { type: "lost", say: "Não estou conseguindo fazer isso nesta página. Quer que eu tente de novo ou prefere falar com o suporte?" };
    } else {
      const decided = await this.decide(context, body.page, [...AGENT_HOSTS, new URL(this.env.WEB_ORIGIN).hostname, ...session.grantedHosts]);
      next = decided.next;
      // Na implantação, um passo só termina com a conferência do Dish Desk, e a sessão só quando todos terminarem.
      if (next.type === "done" && session.kind === "SETUP") {
        const step = decided.step;
        if (step && progress?.steps.find((item) => item.step === step)?.status !== "done") {
          next = { type: "reply", say: `Ainda não vejo ${STEP_LABEL[step]} concluído no Dish Desk. Vamos conferir em Configurações → Integrações?` };
        } else if (!progress?.completed) {
          next = { type: "reply", say: next.say };
        }
      }
      if (next.type === "done") finished = { status: "DONE" };
      if (next.type === "handoff") finished = { status: "HANDED_OFF", reason: next.reason };
    }

    const status = await this.db.withTenants(scope, async (tx) => {
      await event(tx, session, "agent", { next });
      if (!finished) return session.status;
      const updated = await tx.agentSession.update({ where: { id: session.id }, data: { status: finished.status, handoffReason: finished.reason ?? null } });
      return updated.status;
    });
    return { sessionId, status, next, progress };
  }

  /** O parceiro pediu o suporte humano (botão "Falar com o suporte"). */
  async handoff(auth: RequestAuth, sessionId: string): Promise<AgentTurnDto> {
    const scope = { tenantIds: auth.scope.tenantIds, userId: auth.userId };
    return this.db.withTenants(scope, async (tx) => {
      const session = await this.requireSession(tx, auth, sessionId);
      const next: AgentAction = {
        type: "handoff",
        say: "Chamamos alguém da equipe Dish Desk. Ela já recebeu o histórico da conversa e das ações.",
        reason: "O parceiro pediu o suporte",
      };
      await event(tx, session, "agent", { next });
      await tx.agentSession.update({ where: { id: session.id }, data: { status: "HANDED_OFF", handoffReason: next.reason } });
      const progress = session.kind === "SETUP" ? await onboardingOf(tx, session.tenantId) : null;
      return { sessionId, status: "HANDED_OFF", next, progress };
    });
  }

  /** A conversa com o suporte: o que o parceiro escreveu depois da transferência e o que a equipe respondeu. */
  async supportMessages(auth: RequestAuth, sessionId: string): Promise<AgentSupportMessageDto[]> {
    return this.db.withTenants({ tenantIds: auth.scope.tenantIds, userId: auth.userId }, async (tx) => {
      const session = await this.requireHandedOff(tx, auth, sessionId);
      return supportConversation(tx, session.id);
    });
  }

  async sendToSupport(auth: RequestAuth, sessionId: string, text: string): Promise<AgentSupportMessageDto[]> {
    return this.db.withTenants({ tenantIds: auth.scope.tenantIds, userId: auth.userId }, async (tx) => {
      const session = await this.requireHandedOff(tx, auth, sessionId);
      await event(tx, session, "partner", { text });
      return supportConversation(tx, session.id);
    });
  }

  private async requireHandedOff(tx: TenantTx, auth: RequestAuth, sessionId: string) {
    const session = await tx.agentSession.findUnique({ where: { id: sessionId }, select: { id: true, tenantId: true, userId: true, status: true } });
    if (!session || session.userId !== auth.userId) throw new NotFoundException("Sessão não encontrada.");
    if (session.status !== "HANDED_OFF") throw new UnprocessableEntityException("Esta conversa ainda não foi passada para o suporte.");
    return session;
  }

  /** A LLM decide e as travas conferem; uma ação que não serve (ex.: elemento que não existe) volta para a LLM uma vez. */
  private async decide(
    context: { session: { id: string; kind: AgentSessionKind }; restaurant: string; events: EventRow[]; progress: OnboardingDto | null },
    page: PageSnapshot | undefined,
    allowed: string[],
  ): Promise<{ next: AgentAction; step?: OnboardingStep }> {
    const partner = context.events.flatMap((item) => (item.kind === "partner" ? [String((item.content as { text: unknown }).text)] : []));
    const user = `${progressText(context.progress, partner)}${pageText(page)}\n\n${historyText(context.events)}`;
    const known = knownText(context.events, page);
    let note = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      let decision: AgentDecision;
      try {
        decision = await this.llm.json("agente", AgentDecision, [
          { role: "system", content: systemPrompt(context.restaurant, context.session.kind, this.env.WEB_ORIGIN) },
          { role: "user", content: `${user}${note}` },
        ]);
      } catch (error) {
        this.logger.warn(`Agente sem resposta na sessão ${context.session.id}: ${error instanceof Error ? error.message : String(error)}`);
        return { next: { type: "unavailable", say: "O assistente do Dish Desk está fora do ar agora. Quer falar com o suporte?" } };
      }
      const guarded = guard(decision as Decision, page, allowed, known);
      if ("next" in guarded) return { next: guarded.next, step: decision.step === "none" ? undefined : decision.step };
      note = `\n\nATENÇÃO: a sua última decisão não serve: ${guarded.invalid} Decida de novo.`;
    }
    return { next: { type: "lost", say: "Não encontrei o que procurava nesta página. Quer que eu tente de novo ou prefere falar com o suporte?" } };
  }

  private async requireSession(tx: TenantTx, auth: RequestAuth, sessionId: string) {
    const session = await tx.agentSession.findUnique({ where: { id: sessionId }, include: { tenant: { select: { name: true } } } });
    if (!session || session.userId !== auth.userId) throw new NotFoundException("Sessão não encontrada.");
    if (session.status !== "ACTIVE") throw new UnprocessableEntityException("Esta sessão já terminou. Comece outra.");
    return session;
  }
}

/** O que a IA pode preencher: o que o parceiro disse e o que apareceu nas páginas da sessão (e na atual). */
export function knownText(events: EventRow[], page: PageSnapshot | undefined): string {
  const said = events.flatMap(({ content }) => {
    const value = content as Record<string, unknown>;
    return [value.text, value.seen].filter((item): item is string => typeof item === "string");
  });
  const current = page ? [page.text, ...page.elements.flatMap((element) => [element.name, element.value ?? ""])] : [];
  return [...said, ...current].join("\n");
}

/** As mensagens depois da transferência (o evento da IA com `handoff`), do parceiro e da equipe do Dish Desk. */
async function supportConversation(tx: TenantTx, sessionId: string): Promise<AgentSupportMessageDto[]> {
  const events = await tx.agentEvent.findMany({ where: { sessionId, kind: { in: ["agent", "partner", "support"] } }, orderBy: { createdAt: "asc" } });
  const start = events.findIndex((item) => item.kind === "agent" && (item.content as { next?: AgentAction }).next?.type === "handoff");
  return events.slice(start + 1).flatMap((item) => {
    if (item.kind === "agent") return [];
    const content = item.content as { text?: unknown; author?: unknown };
    const author = item.kind === "support" && typeof content.author === "string" ? content.author : null;
    return [{ id: item.id, from: item.kind as "partner" | "support", author, text: String(content.text), createdAt: item.createdAt.toISOString() }];
  });
}

function resultSummary(body: AgentTurnRequest): string | null {
  if (body.confirmed === false) return "o parceiro não confirmou a ação; ela não foi feita.";
  if (body.granted) return `o parceiro permitiu agir em ${body.granted}.`;
  if (!body.result) return null;
  return body.result.ok ? "a ação deu certo." : `a ação falhou: ${body.result.error ?? "erro desconhecido"}.`;
}

function event(tx: TenantTx, session: { id: string; tenantId: string }, kind: AgentEventKind, content: Prisma.InputJsonObject) {
  return tx.agentEvent.create({ data: { tenantId: session.tenantId, sessionId: session.id, kind, content } });
}
