// Evals do agente de pedidos do cardápio (F4-09): os cenários de docs/cardapio-ia/evals/*.json rodam no agente de
// verdade (OrderAgentService, com as ferramentas e o banco), e cada turno é conferido pelas asserções do cenário.
// Quem chama decide o modelo: a API do Claude no `pnpm sim:menu-agent` e um roteiro falso no teste do runner.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { PrismaClient } from "@dishdesk/database";
import { z } from "zod";
import type { ChatWithToolsParams, ChatWithToolsResult, LlmProvider, LlmToolCall } from "../src/ai/llm-provider.js";
import { moneyMentions, type OrderAgentService } from "../src/menu-agent/order-agent.service.js";
import type { TenantDb } from "../src/menu-agent/tools/context.js";
import { menuAgentTools } from "../src/menu-agent/tools/index.js";

export const EVALS_DIR = new URL("../../../docs/cardapio-ia/evals/", import.meta.url);

/** Sexta, 20/11/2026, 20:00 em Brasília: a loja das evals está aberta (18:00 às 23:30). */
export const DEFAULT_WHEN = "2026-11-20T23:00:00.000Z";

export const TEMAS = [
  "pedido-simples",
  "meio-a-meio",
  "ingrediente-alergeno",
  "recomendacao",
  "esgotado",
  "loja-fechada",
  "fora-da-area",
  "audio-transcrito",
  "troca-de-ideia",
  "mudar-preco",
  "desconto",
  "injection",
  "retirada",
  "endereco-salvo",
  "pedido-grande",
  "fora-do-cardapio",
  "entrega",
  "transferencia",
] as const;

const CartItemExpect = z.strictObject({
  /** Parte do nome, sem diferença de acento e maiúscula ("calabresa"). */
  nome: z.string().min(1),
  tamanho: z.string().optional(),
  outraMetade: z.string().optional(),
  quantidade: z.number().int().positive().optional(),
});

/** O que conferir depois de um turno. Os textos de `respostaContem`/`respostaNaoContem` são regex sem diferença de maiúscula. */
export const TurnExpect = z.strictObject({
  /** Todas foram chamadas neste turno. */
  ferramentas: z.array(z.string()).optional(),
  /** Pelo menos uma foi chamada neste turno. */
  algumaFerramenta: z.array(z.string()).optional(),
  /** Nenhuma foi chamada neste turno. */
  semFerramentas: z.array(z.string()).optional(),
  respostaContem: z.array(z.string()).optional(),
  respostaNaoContem: z.array(z.string()).optional(),
  carrinho: z
    .strictObject({
      vazio: z.boolean().optional(),
      /** Cada um está no carrinho; com `exatamente`, o carrinho tem só esses. */
      itens: z.array(CartItemExpect).optional(),
      exatamente: z.boolean().optional(),
      entrega: z.enum(["entrega", "retirada"]).optional(),
      /** O total do carrinho (o do sistema) aparece na resposta. */
      totalNaResposta: z.boolean().optional(),
    })
    .optional(),
  /** A conversa passou (true) ou não (false) para a equipe ao fim do turno. */
  transferencia: z.boolean().optional(),
});
export type TurnExpect = z.infer<typeof TurnExpect>;

export const Scenario = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  titulo: z.string().min(1),
  tema: z.enum(TEMAS),
  /** Hora simulada do primeiro turno (ISO); cada turno seguinte soma 1 minuto. */
  quando: z.iso.datetime({ offset: true }).optional(),
  nomeCliente: z.string().optional(),
  enderecoSalvo: z
    .strictObject({ rotulo: z.string(), rua: z.string(), numero: z.string(), bairro: z.string(), cidade: z.string(), estado: z.string().length(2) })
    .optional(),
  turnos: z.array(z.strictObject({ cliente: z.string().min(1), espera: TurnExpect.optional() })).min(1),
});
export type Scenario = z.infer<typeof Scenario>;

export const EvalFile = z.strictObject({ descricao: z.string().optional(), cenarios: z.array(Scenario).min(1) });

/** Todos os cenários da pasta, validados (um arquivo fora do formato derruba a leitura com o nome dele). */
export function loadEvals(dir: URL = EVALS_DIR): (Scenario & { arquivo: string })[] {
  const files = readdirSync(dir).filter((file) => file.endsWith(".json")).sort();
  return files.flatMap((file) => {
    const parsed = EvalFile.safeParse(JSON.parse(readFileSync(new URL(file, dir), "utf8")));
    if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
    return parsed.data.cenarios.map((scenario) => ({ ...scenario, arquivo: file }));
  });
}

/** Loja das evals (horário, entrega por bairro, retirada, agendamento), aplicada ao restaurante durante a rodada. */
export const EVAL_SETTINGS = {
  businessHours: { enabled: true, days: Array.from({ length: 7 }, () => [{ open: "18:00", close: "23:30" }]), closedMessage: "Estamos fechados agora." },
  menuStore: {
    address: { street: "Rua Harmonia", number: "500", district: "Vila Madalena", city: "São Paulo", state: "SP", zip: "05435-000" },
    pickupEnabled: true,
    prepMinutes: 30,
    delivery: {
      mode: "BY_DISTRICT",
      districts: [
        { district: "Vila Madalena", feeCents: 600 },
        { district: "Pinheiros", feeCents: 800 },
        { district: "Perdizes", feeCents: 1000 },
      ],
    },
    minOrderCents: 3000,
    freeDeliveryFromCents: 20000,
    deliveryMinMinutes: 40,
    deliveryMaxMinutes: 60,
    paymentMethods: ["pix", "cash", "credit"],
    scheduling: { enabled: true, minLeadMinutes: 60, slotMinutes: 30 },
  },
};

/** Roda `fn` com a loja das evals no restaurante e devolve as configurações de antes no fim. */
export async function withEvalStore<T>(admin: PrismaClient, tenantId: string, fn: () => Promise<T>): Promise<T> {
  const { settings } = await admin.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
  await admin.tenant.update({ where: { id: tenantId }, data: { settings: { ...(settings as object), ...EVAL_SETTINGS } }, select: { id: true } });
  try {
    return await fn();
  } finally {
    await admin.tenant.update({ where: { id: tenantId }, data: { settings: settings as object }, select: { id: true } });
  }
}

/** Repassa ao provedor de verdade e guarda as ferramentas chamadas e os tokens (para as asserções e o relatório). */
export class RecordingProvider implements LlmProvider {
  calls: LlmToolCall[] = [];
  tokens = 0;
  constructor(private readonly inner: LlmProvider) {}
  get enabled(): boolean {
    return this.inner.enabled;
  }
  async chatWithTools(params: ChatWithToolsParams): Promise<ChatWithToolsResult> {
    const result = await this.inner.chatWithTools(params);
    this.calls.push(...result.toolCalls);
    this.tokens += result.usage.inputTokens + result.usage.outputTokens;
    return result;
  }
}

export type EvalEnv = {
  tenantId: string;
  channelId: string;
  admin: PrismaClient;
  db: TenantDb;
  agent: OrderAgentService;
  recorder: RecordingProvider;
};

export type TranscriptTurn = { cliente: string; agente: string; ferramentas: string[]; transferiu: boolean };
export type ScenarioResult = { id: string; tema: string; titulo: string; passed: boolean; failures: string[]; transcript: TranscriptTurn[]; tokens: number };

type CartView = {
  status: string;
  itens?: { nome?: string; tamanho?: string; outraMetade?: string; quantidade?: number }[];
  entrega?: { modo?: string };
  total?: { centavos: number; texto: string };
};

const norm = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
const has = (value: string | undefined, part: string) => norm(value ?? "").includes(norm(part));

/** As falhas de um turno (vazio: passou). */
export function checkTurn(expect: TurnExpect, turn: { reply: string; tools: string[]; cart: CartView; transferred: boolean }): string[] {
  const failures: string[] = [];
  for (const tool of expect.ferramentas ?? []) if (!turn.tools.includes(tool)) failures.push(`não chamou ${tool}`);
  if (expect.algumaFerramenta && !expect.algumaFerramenta.some((tool) => turn.tools.includes(tool))) {
    failures.push(`não chamou nenhuma de: ${expect.algumaFerramenta.join(", ")}`);
  }
  for (const tool of expect.semFerramentas ?? []) if (turn.tools.includes(tool)) failures.push(`chamou ${tool}, que não devia`);
  for (const pattern of expect.respostaContem ?? []) if (!new RegExp(pattern, "iu").test(turn.reply)) failures.push(`a resposta não tem /${pattern}/`);
  for (const pattern of expect.respostaNaoContem ?? []) if (new RegExp(pattern, "iu").test(turn.reply)) failures.push(`a resposta tem /${pattern}/, que não devia`);
  if (expect.transferencia !== undefined && expect.transferencia !== turn.transferred) {
    failures.push(expect.transferencia ? "não passou para a equipe" : "passou para a equipe sem precisar");
  }
  const cart = expect.carrinho;
  if (cart) {
    const items = turn.cart.itens ?? [];
    if (cart.vazio !== undefined && cart.vazio !== (items.length === 0)) failures.push(cart.vazio ? `o carrinho devia estar vazio (${items.length} itens)` : "o carrinho está vazio");
    for (const want of cart.itens ?? []) {
      // Meio a meio vale nas duas ordens (calabresa / margherita ou margherita / calabresa).
      const halves = (item: (typeof items)[number]) =>
        (has(item.nome, want.nome) && (!want.outraMetade || has(item.outraMetade, want.outraMetade))) ||
        (!!want.outraMetade && has(item.nome, want.outraMetade) && has(item.outraMetade, want.nome));
      const found = items.some(
        (item) => halves(item) && (!want.tamanho || has(item.tamanho, want.tamanho)) && (!want.quantidade || item.quantidade === want.quantidade),
      );
      if (!found) failures.push(`o carrinho não tem ${JSON.stringify(want)}`);
    }
    if (cart.exatamente && cart.itens && items.length !== cart.itens.length) failures.push(`o carrinho tem ${items.length} itens, esperava ${cart.itens.length}`);
    if (cart.entrega && turn.cart.entrega?.modo !== cart.entrega) failures.push(`a entrega não é "${cart.entrega}" (${turn.cart.entrega?.modo ?? "não definida"})`);
    if (cart.totalNaResposta && !(turn.cart.total && moneyMentions(turn.reply).includes(turn.cart.total.centavos))) {
      failures.push(`a resposta não traz o total do carrinho (${turn.cart.total?.texto ?? "sem total"})`);
    }
  }
  return failures;
}

/** Um cenário do começo ao fim numa conversa nova (apagada no fim). */
export async function runScenario(scenario: Scenario, env: EvalEnv): Promise<ScenarioResult> {
  const { admin, tenantId } = env;
  const contact = await admin.contact.create({
    data: {
      tenantId,
      name: scenario.nomeCliente ?? "Marina Lopes",
      identities: { create: { tenantId, channelType: "WHATSAPP", externalId: `eval-${randomUUID()}` } },
      ...(scenario.enderecoSalvo && {
        addresses: {
          create: {
            tenantId,
            label: scenario.enderecoSalvo.rotulo,
            street: scenario.enderecoSalvo.rua,
            number: scenario.enderecoSalvo.numero,
            district: scenario.enderecoSalvo.bairro,
            city: scenario.enderecoSalvo.cidade,
            state: scenario.enderecoSalvo.estado,
          },
        },
      }),
    },
  });
  const conversation = await admin.conversation.create({
    data: { tenantId, contactId: contact.id, channelId: env.channelId, status: "OPEN", automationState: { ai: "on" } },
  });
  const viewCart = menuAgentTools({ db: env.db }, { conversationId: conversation.id, contactId: contact.id }).find((tool) => tool.name === "ver_carrinho")!;
  const start = new Date(scenario.quando ?? DEFAULT_WHEN).getTime();
  const failures: string[] = [];
  const transcript: TranscriptTurn[] = [];
  const tokensBefore = env.recorder.tokens;
  try {
    for (const [index, turn] of scenario.turnos.entries()) {
      const label = `turno ${index + 1}`;
      const before = await admin.conversation.findUniqueOrThrow({ where: { id: conversation.id }, select: { automationState: true } });
      if ((before.automationState as { ai?: string }).ai !== "on") {
        if (scenario.turnos.slice(index).some((t) => t.espera)) failures.push(`${label}: não rodou, a conversa já estava com a equipe`);
        break;
      }
      const inbound = await admin.message.create({
        data: { tenantId, conversationId: conversation.id, channelId: env.channelId, direction: "INBOUND", type: "TEXT", content: { text: turn.cliente } },
        select: { createdAt: true },
      });
      env.recorder.calls = [];
      await env.agent.reply(tenantId, conversation.id, new Date(start + index * 60_000));
      const tools = env.recorder.calls.map((call) => call.name);
      const replies = await admin.message.findMany({
        where: { conversationId: conversation.id, direction: "OUTBOUND", createdAt: { gte: inbound.createdAt } },
        orderBy: { createdAt: "asc" },
        select: { content: true },
      });
      const reply = replies.map((m) => (m.content as { text?: string }).text ?? "").join("\n");
      const after = await admin.conversation.findUniqueOrThrow({ where: { id: conversation.id }, select: { automationState: true } });
      const transferred = (after.automationState as { ai?: string }).ai !== "on";
      const cart = (await viewCart.handler({}, { tenantId })) as CartView;
      transcript.push({ cliente: turn.cliente, agente: reply, ferramentas: tools, transferiu: transferred });
      if (turn.espera) for (const failure of checkTurn(turn.espera, { reply, tools, cart, transferred })) failures.push(`${label}: ${failure}`);
      // O próximo INBOUND precisa vir depois da resposta (o agente só responde quando a última mensagem é do cliente).
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } catch (error) {
    failures.push(`erro: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await admin.cart.deleteMany({ where: { conversationId: conversation.id } });
    await admin.conversation.delete({ where: { id: conversation.id } });
    await admin.contact.delete({ where: { id: contact.id } });
  }
  return {
    id: scenario.id,
    tema: scenario.tema,
    titulo: scenario.titulo,
    passed: failures.length === 0,
    failures,
    transcript,
    tokens: env.recorder.tokens - tokensBefore,
  };
}

/** O relatório em Markdown: a % de acerto por cenário e, para cada falha, o motivo e a conversa. */
export function renderReport(results: ScenarioResult[][], meta: { model: string; when: Date }): string {
  const runs = results.length;
  const byId = new Map<string, ScenarioResult[]>();
  for (const run of results) for (const result of run) byId.set(result.id, [...(byId.get(result.id) ?? []), result]);
  const all = results.flat();
  const passed = all.filter((r) => r.passed).length;
  const pct = (n: number, total: number) => `${total ? Math.round((n / total) * 100) : 0}%`;
  const tokens = all.reduce((sum, r) => sum + r.tokens, 0);
  const lines = [
    "# Resultados das evals do agente de pedidos",
    "",
    `Rodada de ${meta.when.toISOString().slice(0, 16).replace("T", " ")} (UTC), modelo \`${meta.model}\`, ${runs} ${runs === 1 ? "rodada" : "rodadas"} por cenário, ${tokens.toLocaleString("pt-BR")} tokens.`,
    "",
    `**Acerto geral: ${passed} de ${all.length} (${pct(passed, all.length)}).**`,
    "",
    "| Cenário | Tema | Acerto |",
    "| --- | --- | --- |",
    ...[...byId.values()].map((list) => {
      const ok = list.filter((r) => r.passed).length;
      return `| ${list[0]!.id} | ${list[0]!.tema} | ${ok}/${list.length} (${pct(ok, list.length)}) |`;
    }),
  ];
  const failed = all.filter((r) => !r.passed);
  if (failed.length) lines.push("", "## Falhas");
  for (const result of failed) {
    lines.push("", `### ${result.id}: ${result.titulo}`, "", ...result.failures.map((f) => `- ${f}`), "");
    for (const turn of result.transcript) {
      lines.push(`> **Cliente:** ${turn.cliente.replace(/\n/g, " ")}`);
      lines.push(`> **Agente:** ${turn.agente.replace(/\n/g, " ") || "(sem resposta)"}`);
      lines.push(`> _ferramentas: ${turn.ferramentas.join(", ") || "nenhuma"}${turn.transferiu ? "; passou para a equipe" : ""}_`);
      lines.push(">");
    }
    if (lines.at(-1) === ">") lines.pop();
  }
  return `${lines.join("\n")}\n`;
}
