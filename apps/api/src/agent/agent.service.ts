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
  OnboardingMark,
  type OnboardingStep,
  type PageSnapshot,
} from "@dishdesk/shared";
import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { z } from "zod";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { LlmClient } from "../ai/llm.client.js";
import { markAccepted, markOnboardingStep, onboardingOf } from "../settings/onboarding.service.js";
import { isTenantAdmin } from "../settings/tenant-admin.js";
import { type Decision, guard } from "./agent-guard.js";
import { GUIDE, STEP_LABEL } from "./guide.js";
import { cardapioWebRail } from "./cardapio-web-rail.js";
import { authCodeOf, IFOOD_PORTAL, type IfoodState, ifoodRail, LINK_CODE_HINT, linkCodeOf } from "./ifood-rail.js";
import { extrasOf, INTAKE_INTRO, INTAKE_PROMPT, INTAKE_QUESTIONS, Intake, intakeMarks, nextQuestion } from "./intake.js";

/** Ações seguidas que falharam até a IA parar ("se perdeu"). */
export const MAX_FAILURES = 3;
/** Eventos da sessão que a IA relê a cada volta (os mais recentes). */
const HISTORY_LIMIT = 12;
/** A árvore da página divide o contexto da LLM (8k no Ollama) com o guia e o histórico. */
const ELEMENTS_CHARS = 5000;
const TEXT_CHARS = 1200;
/** A primeira volta da implantação num restaurante sem nada feito: a primeira das perguntas, uma por tópico (INTAKE_QUESTIONS). */
export const FIRST_QUESTION = INTAKE_INTRO + INTAKE_QUESTIONS[0]!.say;
/** Uma ação de navegador pede a mesma resposta para a mesma tela: temperatura baixa (o padrão da conversa é 0,3). */
const AGENT_TEMPERATURE = 0.1;
/** Marcações seguidas (passos pulados) que a IA faz numa volta antes de agir na página. */
const MAX_MARKS = 5;
const MARK_LABEL: Record<OnboardingMark, string> = { skipped: "pulado", confirmed: "padrão mantido", in_progress: "em andamento" };
/** O texto de cada página guardado na sessão (para o que a IA pode preencher depois). */
const SEEN_CHARS = 2000;

export const AgentDecision = z.object({
  say: z.string().trim().min(1).max(700).describe("O que você diz ao parceiro, curto."),
  action: z.enum(["click", "fill", "select", "navigate", "login", "switch", "mark", "reply", "done", "handoff"]),
  ref: z.number().int().min(0).describe("O número [ref] do elemento da PÁGINA; 0 quando a ação não usa elemento."),
  value: z
    .string()
    .max(500)
    .describe('fill e select: o texto ou a opção; navigate e login: o endereço; switch: o site da aba (ex.: www.dishdesk.com.br); mark: skipped (o restaurante não usa ou não quer agora), confirmed (manter o padrão) ou in_progress (esperando um terceiro); senão, "".'),
  irreversible: z.boolean().describe("A ação não dá para desfazer ou fala em nome do restaurante."),
  step: z.enum([...ONBOARDING_STEPS, "none"]).describe('done e mark na implantação: o passo do PROGRESSO; senão, "none".'),
  reason: z.string().max(200).describe('handoff: por que passou para o suporte; senão, "".'),
});
type AgentDecision = z.infer<typeof AgentDecision>;

export function systemPrompt(restaurant: string, kind: AgentSessionKind, panel: string): string {
  const task =
    kind === "SETUP"
      ? "implantar o Dish Desk no restaurante, seguindo a ordem do GUIA, pedindo o mínimo possível ao parceiro. O PROGRESSO diz o que já está feito, pulado ou em andamento. Use action = done só quando todos os passos do PROGRESSO estiverem feitos ou pulados."
      : "tirar dúvidas sobre o Dish Desk e resolver problemas (canal desconectado, mensagem que não chegou, configuração errada), investigando na tela dele. Quando o problema estiver resolvido, use action = done.";
  return `Você é o assistente do Dish Desk dentro da extensão do Chrome e ajuda o parceiro (o dono ou o gerente do restaurante ${restaurant}) a ${task}
O painel do Dish Desk fica em ${panel} (as telas do GUIA ficam nele).
Você vê a página aberta no navegador dele (PÁGINA) e faz uma ação por vez: click, fill (preencher um campo), select (escolher uma opção), navigate (abrir um endereço: no mesmo site, na aba atual; em outro site, numa aba nova, e a atual continua aberta), login (abrir um painel de fora numa aba nova e esperar o parceiro entrar), switch (voltar a uma aba já aberta), mark (marcar um passo do PROGRESSO) ou reply (conversar). Depois de cada ação, você recebe a página de novo.

Regras obrigatórias:
- Para entrar num painel de fora (Portal do Parceiro do iFood, Portal do Cardápio Web, Instagram), use action = login com o endereço dele: a extensão abre uma aba nova, o parceiro digita usuário e senha e clica em "Login feito" (ou "Não consegui"), e você continua. Use login uma vez por site: se ele está em ABAS ABERTAS, volte a ele com switch; se a PÁGINA já mostra o painel logado, siga sem login.
- As RESPOSTAS DO PARCEIRO valem para a implantação toda: use-as nos campos (horário, personalidade, link, nome e e-mail dos atendentes) e não pergunte de novo. O que ele não usa ou deixou no padrão já está marcado no PROGRESSO.
- Faça você mesma tudo que a PÁGINA permite: clicar, copiar o que aparece na tela, preencher e conectar. Nunca peça ao parceiro para ir a uma tela, clicar, copiar ou procurar algo, nem para informar um código, id ou chave que está num painel (abra o painel e leia você mesma): depois do "Login feito" ele não faz mais nada, é você que navega, clica e copia. Em say, diga o que você vai fazer ("Vou abrir Integrações e autorizar.").
- Use reply só quando precisa de uma resposta dele ou quando só ele pode agir (QR Code, senha). Nunca use reply para anunciar o que vai fazer ou o que está procurando: faça a ação.
- Abra cada tela pelo endereço direto do GUIA (navigate), sem clicar em menus. Faça sozinho tudo que a PÁGINA permite; só o parceiro faz o que depende dele (QR Code, senha, código de verificação).
- Cada aba tem a sua PÁGINA. Depois de pegar o que precisa num painel de fora, volte à aba do Dish Desk com action = switch (value = o site, ex.: www.dishdesk.com.br) ANTES de preencher o campo dele: a aba continua como estava, não recarregue.
- Quando só o parceiro pode agir, use reply e diga em say o que ele faz, em passos curtos, e que depois é só escrever "pronto". Ao terminar um passo, vá direto ao próximo, sem perguntar "posso continuar?" nem resumir.
- mark: se ele disser depois que não usa um sistema ou quer o padrão: value = skipped (ou confirmed numa configuração) e o step dele.
- Não repita uma ação que o HISTÓRICO mostra que já deu certo: avance para o próximo passo do GUIA.
- Use só os elementos da PÁGINA, pelo número [ref]. Se o que você procura não está nela, navegue até a tela certa.
- Só afirme o que está no GUIA, no PROGRESSO e na PÁGINA. Sem a informação, passe para o suporte (handoff).
- Nunca preencha senha, código de verificação nem dados de cartão, e nunca peça esses dados na conversa: o parceiro digita direto na página.
- irreversible = true só num click que não dá para desfazer ou que fala em nome do restaurante: aceitar termos, enviar documentos, publicar, pagar, apagar, desconectar. Preencher, salvar e conectar uma integração NÃO são irreversíveis.
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
  // O modelo local segue a ordem do GUIA e ignora o que já está pulado: a API diz qual é o passo da vez.
  const upcoming = progress.steps.find((item) => item.status === "todo" || item.status === "error");
  const turn = upcoming ? `PRÓXIMO PASSO: ${upcoming.step} (${STEP_LABEL[upcoming.step]}). Os feitos e os pulados, não faça.` : "PRÓXIMO PASSO: nenhum, todos feitos ou pulados.";
  return `PROGRESSO (conferido no Dish Desk)\n${lines.join("\n")}\n${turn}\n\n`;
}

type EventRow = { kind: string; content: Prisma.JsonValue };

export type DecideContext = {
  session: { id: string; kind: AgentSessionKind };
  restaurant: string;
  events: EventRow[];
  progress: OnboardingDto | null;
  /** Implantação: as respostas do parceiro às perguntas (`replies`, e `answers` com o tópico de cada uma), se elas já foram lidas (`intakeDone`) e os sites em que ele já entrou. */
  answers: string | null;
  replies: string[];
  /** Os tópicos já perguntados, na ordem das respostas. */
  asked: OnboardingStep[];
  /** A sessão começou pelas perguntas, uma por vez. */
  asking: boolean;
  intakeDone: boolean;
  opened: string[];
  /** iFood: o código de vinculação atual e o que a sessão já fez com ele (o caminho em ifood-rail). */
  ifood?: IfoodState;
};

/** O que `decideWithMarks` grava: a marcação de um passo (com a fala da IA, se foi ela que decidiu) e a leitura da resposta inicial. */
export type MarkStore = {
  mark(step: OnboardingStep, mark: OnboardingMark, summary: { summary: string }, said?: { next: AgentAction }): Promise<OnboardingDto>;
  intakeDone(): Promise<void>;
};

/** O histórico da sessão para a LLM: o que o parceiro pediu, o que a IA disse e fez e o resultado. */
export function historyText(events: EventRow[]): string {
  const lines = events.map(({ kind, content }) => {
    const value = content as Record<string, unknown>;
    if (kind === "partner") return `Parceiro: ${String(value.text)}`;
    if (kind === "result") return `Resultado: ${String(value.summary)}`;
    const next = value.next as AgentAction;
    const action = "action" in next ? ` (${describe(next.action)})` : next.type === "login" ? ` (login ${next.url})` : "";
    return `Você: ${next.say}${action}`;
  });
  return `HISTÓRICO\n${lines.join("\n") || "início da sessão"}`;
}

function describe(action: { type: string; ref?: number; label?: string; value?: string; url?: string; host?: string }): string {
  if (action.type === "navigate") return `navigate ${action.url}`;
  if (action.type === "switch") return `switch ${action.host}`;
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
      const seen = body.page ? { seen: seenOf(body.page) } : {};
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
      const extras = session.kind === "SETUP" ? await sessionExtras(tx, sessionId) : { answers: null, replies: [], asked: [], asking: false, intakeDone: false, opened: [] };
      return { session: updated, restaurant: session.tenant.name, events, progress, ...extras };
    });
    const { session } = context;
    let { progress } = context;

    let next: AgentAction;
    let finished: { status: "DONE" | "HANDED_OFF"; reason?: string } | null = null;
    if (session.failures >= MAX_FAILURES) {
      next = { type: "lost", say: "Não estou conseguindo fazer isso nesta página. Quer que eu tente de novo ou prefere falar com o suporte?" };
    } else {
      const allowed = [...AGENT_HOSTS, new URL(this.env.WEB_ORIGIN).hostname, ...session.grantedHosts];
      const decided = await this.decideWithMarks(context, body.page, allowed, {
        mark: (step, mark, summary, said) =>
          this.db.withTenants(scope, async (tx) => {
            const updated = await markOnboardingStep(tx, session.tenantId, step, mark);
            if (said) await event(tx, session, "agent", said);
            await event(tx, session, "result", summary);
            return updated;
          }),
        intakeDone: () => this.db.withTenants(scope, async (tx) => void (await event(tx, session, "result", { intake: true }))),
      });
      progress = decided.progress;
      next = decided.next;
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

  /**
   * Uma volta da IA. Marcar um passo (pulado, padrão) é feito na API, sem a extensão (`saveMark` grava e devolve o
   * progresso): a IA já decide a próxima ação na mesma volta, até `MAX_MARKS` marcações seguidas.
   */
  async decideWithMarks(
    context: DecideContext,
    page: PageSnapshot | undefined,
    allowed: string[],
    store: MarkStore,
  ): Promise<{ next: AgentAction; step?: OnboardingStep; progress: OnboardingDto | null }> {
    if (context.session.kind === "SETUP" && !context.events.some((item) => item.kind === "agent") && !askedSomething(context.events)) {
      // O que já está feito no Dish Desk não é perguntado; sem nada a perguntar, a IA segue direto para o que falta.
      const first = nextQuestion(context.progress, []);
      if (first) return { next: { type: "reply", say: INTAKE_INTRO + first.say }, progress: context.progress };
    }
    const apply = async (step: OnboardingStep, mark: OnboardingMark, said?: { next: AgentAction }) => {
      const summary = { summary: `o passo ${step} (${STEP_LABEL[step]}) foi marcado como ${MARK_LABEL[mark]}.` };
      context.progress = await store.mark(step, mark, summary, said);
      context.events = [...context.events, ...(said ? [{ kind: "agent", content: said }] : []), { kind: "result", content: summary }].slice(-HISTORY_LIMIT);
    };
    if (context.session.kind === "SETUP" && context.asking && !context.intakeDone) {
      // Uma pergunta por vez, até acabarem as que faltam; se o parceiro perguntar algo no meio, as perguntas param e a IA responde.
      const upcoming = context.replies.at(-1)?.includes("?") ? undefined : nextQuestion(context.progress, context.asked);
      if (upcoming) return { next: { type: "reply", say: upcoming.say }, progress: context.progress };
    }
    if (context.session.kind === "SETUP" && context.asking && !context.intakeDone) {
      const intake = await this.llm
        .json("resposta_inicial", Intake, [
          { role: "system", content: INTAKE_PROMPT },
          { role: "user", content: `Respostas do parceiro:\n${context.answers}` },
        ])
        .catch((error) => {
          this.logger.warn(`Resposta inicial não lida na sessão ${context.session.id}: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
      for (const { step, mark } of intake ? intakeMarks(intake) : []) {
        if (context.progress?.steps.find((item) => item.step === step)?.status === "todo") await apply(step, mark);
      }
      await store.intakeDone();
      context.intakeDone = true;
    }
    let decided = await this.decide(context, page, allowed);
    for (let marks = 0; decided.mark && marks < MAX_MARKS; marks++) {
      await apply(decided.mark.step, decided.mark.mark, { next: decided.next });
      decided = await this.decide(context, page, allowed);
    }
    // Na implantação, um passo só termina com a conferência do Dish Desk, e a sessão só quando todos terminarem.
    let { next } = decided;
    if (next.type === "done" && context.session.kind === "SETUP") {
      const { step } = decided;
      if (step && context.progress?.steps.find((item) => item.step === step)?.status !== "done") {
        next = { type: "reply", say: `Ainda não vejo ${STEP_LABEL[step]} concluído no Dish Desk. Vamos conferir em Configurações → Integrações?` };
      } else if (!context.progress?.completed) {
        next = { type: "reply", say: pendingSay(context.progress, next.say) };
      }
    }
    return { next, step: decided.step, progress: context.progress };
  }

  /** A LLM decide e as travas conferem; uma ação que não serve (ex.: elemento que não existe) volta para a LLM uma vez. */
  private async decide(
    context: DecideContext,
    page: PageSnapshot | undefined,
    allowed: string[],
  ): Promise<{ next: AgentAction; step?: OnboardingStep; mark?: { step: OnboardingStep; mark: OnboardingMark } }> {
    const partner = context.events.flatMap((item) => (item.kind === "partner" ? [String((item.content as { text: unknown }).text)] : []));
    const user = `${progressText(context.progress, partner)}${answersText(context)}${pageText(page)}${previousText(context.events, page)}\n\n${historyText(context.events)}`;
    const known = `${knownText(context.events, page)}\n${context.answers ?? ""}`;
    const railed = this.railIfood(context, page) ?? this.railCardapioWeb(context, page);
    if (railed) {
      let guarded = guard(railed.decision, page, allowed, known);
      // iFood: o parceiro cola os códigos (o de vinculação nas caixinhas do portal, o de autorização no Dish Desk) com o botão Copiar.
      if ("next" in guarded && railed.step === "ifood" && railed.decision.action === "fill") {
        const { say, ref, value } = railed.decision;
        guarded = { next: { type: "your_turn", say, ref, field: "code", copy: value } };
      }
      // Uma escolha do restaurante (ex.: quais lojas do iFood conectar): o caminho pede a confirmação dele.
      if ("next" in guarded && guarded.next.type === "act" && railed.decision.irreversible) guarded = { next: { ...guarded.next, type: "confirm" } };
      if ("next" in guarded && !repeatsLast(context.events, guarded.next)) return { next: guarded.next, step: railed.step };
    }
    let note = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      let decision: AgentDecision;
      try {
        decision = await this.llm.json("agente", AgentDecision, [
          { role: "system", content: systemPrompt(context.restaurant, context.session.kind, this.env.WEB_ORIGIN) },
          { role: "user", content: `${user}${note}` },
        ], AGENT_TEMPERATURE);
      } catch (error) {
        this.logger.warn(`Agente sem resposta na sessão ${context.session.id}: ${error instanceof Error ? error.message : String(error)}`);
        return { next: { type: "unavailable", say: "O assistente do Dish Desk está fora do ar agora. Quer falar com o suporte?" } };
      }
      if (decision.action === "mark") {
        const mark = OnboardingMark.safeParse(decision.value);
        if (context.session.kind !== "SETUP" || decision.step === "none" || !mark.success || !markAccepted(decision.step, mark.data)) {
          note = `\n\nATENÇÃO: a sua última decisão não serve: mark precisa de um step do PROGRESSO e de value skipped (integração ou configuração), confirmed (só configuração) ou in_progress (só integração). Decida de novo.`;
          continue;
        }
        const status = context.progress?.steps.find((item) => item.step === decision.step)?.status;
        if (status && status !== "todo" && status !== "error") {
          note = `\n\nATENÇÃO: o passo ${decision.step} já está ${status === "done" ? "feito" : "marcado"} no PROGRESSO. Siga para o que ainda está a fazer.`;
          continue;
        }
        return { next: { type: "reply", say: decision.say }, mark: { step: decision.step, mark: mark.data } };
      }
      if (decision.action === "done" && context.session.kind === "SETUP" && context.progress && !context.progress.completed && attempt === 0) {
        const pending = context.progress.steps.filter((item) => item.status === "todo" || item.status === "error").map((item) => STEP_LABEL[item.step]);
        note = `\n\nATENÇÃO: ainda faltam passos no PROGRESSO: ${pending.join(", ")}. Não use done: faça o próximo passo; se só o parceiro pode agir, use reply com a instrução.`;
        continue;
      }
      // Um site já aberto não se abre de novo: volta-se à aba dele (o Dish Desk, onde o parceiro abriu o painel, sempre está aberta).
      const target = decision.action === "login" || decision.action === "navigate" ? hostOf(decision.value) : null;
      const open = [new URL(this.env.WEB_ORIGIN).hostname, ...context.opened];
      const current = page ? hostOf(page.url) : null;
      const tab = target && open.find((host) => target === host || target.endsWith(`.${host}`));
      if (tab && (decision.action === "login" || target !== current)) decision = { ...decision, action: "switch", value: tab };
      const guarded = guard(decision as Decision, page, allowed, known);
      if ("next" in guarded && repeatsLast(context.events, guarded.next)) {
        this.logger.debug(`Ação repetida na sessão ${context.session.id}: ${JSON.stringify(guarded.next)}`);
        note = "\n\nATENÇÃO: você acabou de fazer exatamente essa ação e ela deu certo; a PÁGINA já mostra o resultado. Faça o próximo passo do GUIA, ou, se só o parceiro pode agir agora, use reply com a instrução.";
        continue;
      }
      if ("next" in guarded) return { next: guarded.next, step: decision.step === "none" ? undefined : decision.step };
      this.logger.debug(`Decisão recusada na sessão ${context.session.id}: ${guarded.invalid} | ${JSON.stringify(decision)}`);
      note = `\n\nATENÇÃO: a sua última decisão não serve: ${guarded.invalid} Decida de novo.`;
    }
    return { next: { type: "lost", say: "Não encontrei o que procurava nesta página. Quer que eu tente de novo ou prefere falar com o suporte?" } };
  }

  /** Na implantação, com o iFood a fazer: o caminho fixo do portal (ifood-rail), antes da LLM. */
  private railIfood(context: DecideContext, page: PageSnapshot | undefined): { decision: Decision; step: OnboardingStep } | null {
    if (!pendingStep(context, "ifood") || !context.ifood) return null;
    const decision = ifoodRail({ page, panelHost: this.panelHost, opened: context.opened, ...context.ifood });
    return decision && { decision, step: "ifood" };
  }

  /** Na implantação, com o Cardápio Web a fazer: o caminho fixo do portal até a API de integração (cardapio-web-rail). */
  private railCardapioWeb(context: DecideContext, page: PageSnapshot | undefined): { decision: Decision; step: OnboardingStep } | null {
    if (!pendingStep(context, "cardapio_web")) return null;
    const decision = cardapioWebRail({ page, panelHost: this.panelHost });
    return decision && { decision, step: "cardapio_web" };
  }

  private get panelHost(): string {
    return new URL(this.env.WEB_ORIGIN).hostname;
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
  const current = page ? [page.url, page.text, ...page.elements.flatMap((element) => [element.name, element.value ?? ""])] : [];
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

/** O parceiro fez uma pergunta (e não só pediu a implantação): a IA responde a ela, em vez da pergunta inicial. */
function askedSomething(events: EventRow[]): boolean {
  return events.some(({ kind, content }) => kind === "partner" && String((content as { text?: unknown }).text).includes("?"));
}

/** A resposta inicial do parceiro e os sites em que ele já entrou: ficam à vista da IA em toda volta, além do histórico recente. */
function answersText({ answers, opened }: DecideContext): string {
  const said = answers ? `RESPOSTAS DO PARCEIRO (às perguntas iniciais, por tópico; use nos campos, não pergunte de novo)\n${answers.slice(0, 800)}\n\n` : "";
  const tabs = opened.length ? `ABAS ABERTAS (já abertas nesta sessão: volte com switch, sem abrir nem fazer login de novo)\n${opened.join(", ")}\n\n` : "";
  return said + tabs;
}

/** Do registro todo da sessão, só o que o prompt precisa sempre: a primeira fala da IA, a resposta do parceiro, a leitura dela e os logins. */
async function sessionExtras(tx: TenantTx, sessionId: string) {
  // As primeiras falas da IA são as perguntas (uma por tópico, no máximo INTAKE_QUESTIONS.length).
  const spoken = await tx.agentEvent.findMany({ where: { sessionId, kind: "agent" }, orderBy: { createdAt: "asc" }, take: INTAKE_QUESTIONS.length + 1 });
  const first = spoken[0];
  if (!first) return extrasOf([]);
  const [answers, intake, logins, tabs, link] = await Promise.all([
    tx.agentEvent.findMany({ where: { sessionId, kind: "partner", createdAt: { gte: first.createdAt } }, orderBy: { createdAt: "asc" }, take: INTAKE_QUESTIONS.length }),
    tx.agentEvent.findFirst({ where: { sessionId, kind: "result", content: { path: ["intake"], equals: true } } }),
    tx.agentEvent.findMany({ where: { sessionId, kind: "agent", content: { path: ["next", "type"], equals: "login" } } }),
    tx.agentEvent.findMany({ where: { sessionId, kind: "agent", content: { path: ["next", "action", "newTab"], equals: true } } }),
    tx.agentEvent.findFirst({ where: { sessionId, content: { path: ["seen"], string_contains: LINK_CODE_HINT } }, orderBy: { createdAt: "desc" } }),
  ]);
  const rows = [...new Map([...spoken, ...answers, ...(intake ? [intake] : []), ...logins, ...tabs].map((row) => [row.id, row])).values()].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  return { ...extrasOf(rows), ifood: await ifoodState(tx, sessionId, seenIn(link)) };
}

/**
 * O código de vinculação atual (a última página do Dish Desk com ele) e o que a sessão fez depois que ele apareceu: o
 * código de autorização do portal, o Continuar e o Conectar de um código recusado ou vencido não contam para o novo.
 */
async function ifoodState(tx: TenantTx, sessionId: string, linkSeen: string | null): Promise<IfoodState> {
  const linkCode = linkCodeOf(linkSeen);
  const first = linkCode
    ? await tx.agentEvent.findFirst({ where: { sessionId, content: { path: ["seen"], string_contains: linkCode } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } })
    : null;
  if (!linkCode || !first) return { linkCode: null, authCode: null, submitted: false, connected: false };
  const since = { gt: first.createdAt };
  const clicked = (label: string) =>
    tx.agentEvent.findFirst({ where: { sessionId, kind: "agent", createdAt: since, content: { path: ["next", "action", "label"], equals: label } }, select: { id: true } });
  const [portal, continued, pasted, connected] = await Promise.all([
    tx.agentEvent.findFirst({
      where: { sessionId, createdAt: since, content: { path: ["seen"], string_starts_with: `Endereço: https://${IFOOD_PORTAL}` } },
      orderBy: { createdAt: "desc" },
    }),
    clicked("Continuar"),
    // O cartão de colar o código de vinculação: quem clica em Continuar no iFood pode ser o parceiro.
    tx.agentEvent.findFirst({ where: { sessionId, kind: "agent", createdAt: since, content: { path: ["next", "copy"], equals: linkCode } }, select: { id: true } }),
    clicked("Conectar"),
  ]);
  return { linkCode, authCode: authCodeOf(seenIn(portal), linkCode), submitted: !!continued || !!pasted, connected: !!connected };
}

/** Na implantação, o passo ainda está a fazer (ou com erro): os caminhos fixos dos portais só valem aí. */
function pendingStep(context: DecideContext, step: OnboardingStep): boolean {
  const status = context.progress?.steps.find((item) => item.step === step)?.status;
  return context.session.kind === "SETUP" && (status === "todo" || status === "error");
}

function seenIn(row:{ content: Prisma.JsonValue } | null): string | null {
  const seen = (row?.content as { seen?: unknown } | null)?.seen;
  return typeof seen === "string" ? seen : null;
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/**
 * O texto da página de antes da última ação: ao voltar para outra aba (switch), o que apareceu na anterior (ex.: o código
 * de autorização do iFood) ainda está à vista da IA para copiar. O histórico só guarda o que foi dito e feito.
 */
function previousText(events: EventRow[], page: PageSnapshot | undefined): string {
  const current = page ? seenOf(page) : undefined;
  const host = page ? hostOf(page.url) : null;
  const texts = events.flatMap(({ content }) => {
    const text = (content as { seen?: unknown }).seen;
    return typeof text === "string" && text !== current ? [text] : [];
  });
  // De preferência a última página de outro site: depois de preencher um campo no Dish Desk, o que foi copiado do portal continua à vista.
  const seen = texts.findLast((text) => hostOf(text.match(/^Endereço: (\S+)/)?.[1] ?? "") !== host) ?? texts.at(-1);
  return seen ? `\n\nPÁGINA ANTERIOR (só o texto e os campos, para copiar o que apareceu nela)\n${seen.slice(0, 1200)}` : "";
}

/** O que fica guardado de uma página para a IA copiar depois: o endereço (às vezes traz o código da loja), os valores dos campos e o texto. */
function seenOf(page: PageSnapshot): string {
  const values = page.elements.filter((element) => element.value && !element.sensitive).map((element) => `${element.name || element.role}: ${element.value}`);
  return [`Endereço: ${page.url}`, ...values, page.text].join("\n").slice(0, SEEN_CHARS);
}

/** A ação é igual à última que a IA fez e a anterior deu certo: ela está repetindo (ex.: abrir o mesmo endereço de novo). */
function repeatsLast(events: EventRow[], next: AgentAction): boolean {
  if (next.type !== "act" && next.type !== "confirm") return false;
  const last = events.findLast((item) => item.kind === "agent");
  const lastNext = (last?.content as { next?: AgentAction } | undefined)?.next;
  if (!last || (lastNext?.type !== "act" && lastNext?.type !== "confirm")) return false;
  const after = events.slice(events.indexOf(last) + 1).findLast((item) => item.kind === "result");
  const worked = (after?.content as { ok?: unknown } | undefined)?.ok !== false && /deu certo/.test(String((after?.content as { summary?: unknown } | undefined)?.summary));
  return worked && JSON.stringify(lastNext.action) === JSON.stringify(next.action);
}

/** O que dizer ao parceiro quando a IA quis encerrar mas falta passo: só a mensagem de teste pede a ação dele, com a instrução pronta. */
function pendingSay(progress: OnboardingDto | null, said: string): string {
  const pending = progress?.steps.filter((item) => item.status === "todo" || item.status === "error") ?? [];
  if (pending.length === 1 && pending[0]!.step === "first_message") {
    return "Falta só um teste: de outro celular, mande uma mensagem para o WhatsApp do restaurante que acabamos de conectar. Quando ela chegar na Inbox, a implantação termina. Escreva \"pronto\" depois de enviar.";
  }
  return said;
}
