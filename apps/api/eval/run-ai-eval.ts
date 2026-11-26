// Avaliação da IA de atendimento: roda os casos de eval/ai-cases.json com o prompt e o modelo da produção, confere cada
// resposta (handoff, skip, frases proibidas e exigidas) e pede a nota de um juiz (modelo mais forte). Fora do vitest e
// do CI: cada rodada chama a API do Claude e custa. Nada vai para o banco nem para os clientes.
//
//   pnpm --filter @dishdesk/api eval:ai -- --label antes
//   --runs 3          respostas por caso (padrão 3; a verificação automática vale para todas)
//   --judge-runs 1    quantas dessas o juiz avalia (padrão 1)
//   --only a,b        só esses casos (ids)
//   --budget 1.5      para a rodada se o gasto passar disso, em dólares (padrão 1.5)
//   --dry             só monta as mensagens e mostra o tamanho, sem chamar a API
//
// A chave vem de AI_FALLBACK_API_KEY (a do Claude na API) ou ANTHROPIC_API_KEY, no terminal ou no .env da raiz.
// Resultado: eval/results/<label>.json e eval/results/<label>.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ChannelType, MessageType, OrderStatus } from "@dishdesk/database/enums";
import { businessHoursOf, closedAt, type OrderOrigin, reopeningAt } from "@dishdesk/shared";
import { z } from "zod";
import type { Attendance } from "../src/ai/ai-forward.service.js";
import { AttendantReply, attendantMessages, attendantOrderFacts, type OrderFacts } from "../src/ai/ai-attendant.service.js";
import { CLAUDE_PRICES, claudeRequest, type LlmMessage } from "../src/ai/llm.client.js";
import { transcript } from "../src/ai/prompts.js";
import { firstName } from "../src/automations/automation.js";

const here = dirname(fileURLToPath(import.meta.url));
const rootEnv = join(here, "../../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// ---------- Casos ----------

const Expect = z.union([z.boolean(), z.literal("qualquer")]);
const Restaurant = z.object({
  nome: z.string(),
  personalidade: z.string(),
  horario: z.array(z.tuple([z.string(), z.string()])),
  links: z.array(z.object({ label: z.string(), url: z.string() })),
});
const Case = z.object({
  id: z.string(),
  categoria: z.string(),
  origem: z.string(),
  canal: z.enum(["WHATSAPP", "INSTAGRAM", "IFOOD", "MESSENGER", "WEBCHAT"]),
  restaurante: z.string(),
  pausa: z.object({ desde: z.string(), ate: z.string().nullable(), motivo: z.string() }).optional(),
  agora: z.string(),
  atendentes: z.enum(["online", "offline", "fechado"]),
  cliente: z.object({ nome: z.string().optional(), semTelefone: z.boolean().optional() }),
  pedido: z
    .object({
      numero: z.string(),
      canal: z.string(),
      feitoEm: z.string(),
      status: z.enum(["PLACED", "CONFIRMED", "PREPARING", "READY", "DISPATCHED", "DELIVERED", "CANCELED"]),
      itens: z.array(z.tuple([z.number(), z.string()])),
      total: z.number(),
      andamento: z.string().optional(),
      confirmado: z.boolean().optional(),
      porNumero: z.boolean().optional(),
      numeroInformado: z.boolean().optional(),
      chatIfood: z.boolean().optional(),
      retirada: z.boolean().optional(),
      semSaida: z.boolean().optional(),
      motivoCancelamento: z.string().optional(),
      oferecido: z.boolean().optional(),
    })
    .nullable(),
  conversa: z.array(z.tuple([z.enum(["cliente", "ia", "atendente", "loja", "automacao"]), z.string()])),
  esperado: z.object({
    handoff: Expect,
    skip: Expect.default(false),
    courier: z.boolean().optional(),
    order: z.enum(["confirmed", "denied", "none"]).optional(),
    reason: z.string().optional(),
    proibidas: z.array(z.string()).default([]),
    exigidas: z.array(z.string()).default([]),
    nota: z.string(),
  }),
});
type Case = z.infer<typeof Case>;
const CaseFile = z.object({ proibidasSempre: z.array(z.string()), restaurantes: z.record(z.string(), Restaurant), casos: z.array(Case) });
type CaseFile = z.infer<typeof CaseFile>;

const MEDIA: Record<string, MessageType> = { "[imagem]": "IMAGE", "[áudio]": "AUDIO", "[vídeo]": "VIDEO", "[documento]": "DOCUMENT" };

/** As mensagens da LLM para o caso, montadas pelas mesmas funções do atendimento. */
export function caseMessages(file: CaseFile, item: Case): LlmMessage[] {
  const restaurant = file.restaurantes[item.restaurante];
  if (!restaurant) throw new Error(`${item.id}: restaurante ${item.restaurante} não existe`);
  const now = new Date(item.agora);
  const shifts = restaurant.horario.map(([open, close]) => ({ open, close }));
  const settings = {
    personality: restaurant.personalidade,
    orderLinks: restaurant.links,
    businessHours: { enabled: true, days: Array.from({ length: 7 }, () => shifts), closedMessage: "Estamos fechados agora. Voltamos {retorno}." },
    closures: item.pausa ? [{ id: "pausa", from: new Date(item.pausa.desde).toISOString(), until: item.pausa.ate && new Date(item.pausa.ate).toISOString(), reason: item.pausa.motivo }] : [],
  };
  const hours = businessHoursOf(settings);
  const attendance: Attendance = closedAt(hours, now)
    ? { available: false, reason: "closed", reopening: reopeningAt(hours, now) }
    : item.atendentes === "online"
      ? { available: true }
      : { available: false, reason: "offline" };
  const order = item.pedido;
  const facts: OrderFacts | null = order && {
    displayCode: order.numero,
    externalOrderId: order.numero,
    channelType: order.canal as OrderOrigin,
    placedAt: new Date(order.feitoEm),
    status: order.status as OrderStatus,
    items: order.itens.map(([quantity, name]) => ({ quantity, name })),
    total: order.total,
    update: order.andamento ? { text: order.andamento } : null,
    confirmed: !!(order.confirmado || order.numeroInformado || order.chatIfood),
    byNumber: !!order.porNumero,
    autoConfirmed: !!order.numeroInformado,
    chatOrder: !!order.chatIfood,
    cancellationReason: order.motivoCancelamento ?? null,
    takeout: !!order.retirada,
    skipsDispatch: !!order.semSaida,
  };
  const start = now.getTime() - item.conversa.length * 60_000;
  const history = item.conversa.map(([who, text], index) => ({
    direction: who === "cliente" ? "INBOUND" : "OUTBOUND",
    type: MEDIA[text] ?? ("TEXT" as MessageType),
    content: MEDIA[text] ? {} : { text, ...(who === "ia" && { aiReply: true }), ...(who === "automacao" && { automation: "aviso" }) },
    sentByUserId: who === "atendente" ? "atendente" : null,
    createdAt: new Date(start + index * 60_000),
  }));
  const noPhone = !!item.cliente.semTelefone;
  return attendantMessages(restaurant.nome, item.canal as ChannelType, settings, now, attendantOrderFacts(facts, noPhone), transcript(history), attendance, {
    first: !item.conversa.some(([who]) => who === "ia"),
    name: firstName(item.cliente.nome ?? null),
  });
}

// ---------- Verificação automática ----------

type Reply = z.infer<typeof AttendantReply>;

function check(file: CaseFile, item: Case, reply: Reply): string[] {
  const failures: string[] = [];
  const want = item.esperado;
  if (want.handoff !== "qualquer" && reply.handoff !== want.handoff) failures.push(`handoff ${reply.handoff}, esperado ${want.handoff}`);
  if (want.skip !== "qualquer" && reply.skip !== want.skip) failures.push(`skip ${reply.skip}, esperado ${want.skip}`);
  if (want.courier !== undefined && reply.courier !== want.courier) failures.push(`courier ${reply.courier}, esperado ${want.courier}`);
  if (want.order && reply.order !== want.order) failures.push(`order ${reply.order}, esperado ${want.order}`);
  if (want.reason && !new RegExp(want.reason, "i").test(reply.reason)) failures.push(`reason não começa com ${want.reason}`);
  // Sem mensagem (skip), o texto não sai: as frases não contam.
  if (!(reply.skip && !reply.handoff)) {
    for (const pattern of [...file.proibidasSempre, ...want.proibidas]) {
      const match = reply.reply.match(new RegExp(pattern, "i"));
      if (match) failures.push(`frase proibida "${match[0]}"`);
    }
    for (const pattern of want.exigidas) {
      if (!new RegExp(pattern, "i").test(reply.reply)) failures.push(`falta /${pattern}/`);
    }
  }
  return failures;
}

// ---------- Juiz ----------

const JUDGE_MODEL = "claude-sonnet-5-5";
const Verdict = z.object({
  correcao: z.number().int().min(1).max(5).describe("Fez a coisa certa: chamou ou não a equipe, respondeu ao que o cliente pediu."),
  naoInventa: z.number().int().min(1).max(5).describe("Só afirma o que está nos DADOS; 5 = nada inventado."),
  tom: z.number().int().min(1).max(5).describe("Soa como alguém da equipe no WhatsApp, no tom da personalidade, sem frase de robô."),
  concisao: z.number().int().min(1).max(5).describe("Curta e direta, sem repetir o que já foi dito."),
  nota: z.number().int().min(1).max(5).describe("Nota geral da resposta."),
  motivo: z.string().describe("Até 300 caracteres: o principal acerto ou erro."),
});
type Verdict = z.infer<typeof Verdict>;

const JUDGE_SYSTEM = `Você avalia a resposta de um atendente virtual de restaurante (WhatsApp, Instagram ou chat do iFood). Princípios do bom atendimento:
- Só afirma o que está nos DADOS. Informação da casa que não está nos DADOS (item ou combo específico, ingrediente, alergia, área de entrega, cupom, consumo no local, objeto esquecido, política) vai para a equipe (handoff = true), sem dizer se tem ou não e sem expor o que o atendente não sabe.
- Um extra para o pedido já feito (hashi, talher, molho) ou um recado para o entregador é observação para a equipe, não pedido novo nem link.
- Nunca diz que o pedido não existe ou não foi encontrado; não inventa causa, previsão nem horário.
- Loja pausada ou fechada nos DADOS: nunca diz que está aberta nem manda pedir.
- Responde na primeira frase ao que o cliente pediu, mesmo que tenha vindo junto de um cumprimento.
- Mensagens curtas, como alguém da equipe digitando, no tom da personalidade, sem frases prontas de assistente.
Campos da resposta: reply (a mensagem), handoff (true = a conversa vai para a equipe), skip (true = nada é enviado), order (resposta do cliente a "é esse o seu pedido?"), courier (quem escreve parece entregador).
Avalie de 1 (ruim) a 5 (ótima). Use a NOTA DO CASO como referência do que é uma boa resposta. Uma resposta com skip = true não manda texto: avalie se não responder era o certo.`;

async function judge(client: Anthropic, item: Case, messages: LlmMessage[], reply: Reply) {
  const context = messages.find((message) => message.role === "user")!.content;
  const response = await client.messages.parse({
    model: JUDGE_MODEL,
    max_tokens: 16000,
    system: JUDGE_SYSTEM,
    messages: [{ role: "user", content: `NOTA DO CASO\n${item.esperado.nota}\n\n${context}\n\nRESPOSTA DO ATENDENTE\n${JSON.stringify(reply)}` }],
    output_config: { effort: "low", format: zodOutputFormat(Verdict) },
  });
  return { verdict: response.parsed_output, usage: response.usage, model: JUDGE_MODEL };
}

// ---------- Custo ----------

function costOf(model: string, usage: { input_tokens: number; output_tokens: number }): number {
  const price = CLAUDE_PRICES[model];
  if (!price) throw new Error(`Sem preço para ${model}`);
  return (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1_000_000;
}

// ---------- Rodada ----------

type RunResult = { run: number; reply: Reply | null; error?: string; failures: string[]; verdict?: Verdict | null; costUsd: number; ms: number };
type CaseResult = { id: string; categoria: string; nota: string; runs: RunResult[] };

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const file = CaseFile.parse(JSON.parse(readFileSync(join(here, "ai-cases.json"), "utf8")));
  const only = new Set((arg("only") ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  const cases = file.casos.filter((item) => !only.size || only.has(item.id));
  const runs = Number(arg("runs") ?? 3);
  const judgeRuns = Number(arg("judge-runs") ?? 1);
  const budget = Number(arg("budget") ?? 1.5);
  const label = arg("label") ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const model = process.env.AI_FALLBACK_MODEL ?? "claude-haiku-5-5";

  const ids = new Set<string>();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`id repetido: ${item.id}`);
    ids.add(item.id);
  }
  if (process.argv.includes("--dry")) {
    for (const item of cases) {
      const messages = caseMessages(file, item);
      console.log(`${item.id.padEnd(40)} ${messages.map((message) => message.content.length).join(" + ")} caracteres`);
    }
    console.log(`\n${cases.length} casos montados.`);
    if (only.size === 1) console.log(`\n${caseMessages(file, cases[0]!).at(-1)!.content}`);
    return;
  }
  const apiKey = process.env.AI_FALLBACK_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("Falta a chave do Claude: defina AI_FALLBACK_API_KEY (ou ANTHROPIC_API_KEY) no terminal ou no .env da raiz.");
    process.exitCode = 1;
    return;
  }
  const client = new Anthropic({ apiKey });

  let spent = 0;
  let stopped = false;
  const results: CaseResult[] = cases.map((item) => ({ id: item.id, categoria: item.categoria, nota: item.esperado.nota, runs: [] }));
  const jobs = cases.flatMap((item, index) => Array.from({ length: runs }, (_, run) => ({ item, index, run })));
  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      if (spent > budget) {
        stopped = true;
        return;
      }
      const { item, index, run } = job;
      const messages = caseMessages(file, item);
      const started = Date.now();
      const result: RunResult = { run, reply: null, failures: [], costUsd: 0, ms: 0 };
      try {
        const response = await client.messages.parse(claudeRequest(model, AttendantReply, messages));
        result.costUsd += costOf(model, response.usage);
        if (response.stop_reason === "refusal") throw new Error("recusa");
        result.reply = response.parsed_output ?? null;
        if (!result.reply) throw new Error("sem resposta");
        result.failures = check(file, item, result.reply);
        result.ms = Date.now() - started;
        if (run < judgeRuns) {
          const judged = await judge(client, item, messages, result.reply);
          result.verdict = judged.verdict;
          result.costUsd += costOf(judged.model, judged.usage);
        }
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        result.failures.push(`erro: ${result.error}`);
      }
      spent += result.costUsd;
      results[index]!.runs.push(result);
      console.log(`${result.failures.length ? "FALHOU" : "ok    "} ${item.id}#${run + 1}${result.verdict ? ` nota ${result.verdict.nota}` : ""}${result.failures.length ? `: ${result.failures.join("; ")}` : ""}`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  for (const result of results) result.runs.sort((a, b) => a.run - b.run);

  const outDir = join(here, "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${label}.json`), JSON.stringify({ label, model, judge: JUDGE_MODEL, runs, spentUsd: spent, stopped, results }, null, 2));
  const report = renderReport(label, model, results, spent, stopped);
  writeFileSync(join(outDir, `${label}.md`), report);
  console.log(`\n${report}`);
}

function renderReport(label: string, model: string, results: CaseResult[], spent: number, stopped: boolean): string {
  const all = results.flatMap((result) => result.runs);
  const passed = all.filter((run) => !run.failures.length).length;
  const verdicts = all.flatMap((run) => (run.verdict ? [run.verdict] : []));
  const avg = (values: number[]) => (values.length ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2) : "-");
  const categories = [...new Set(results.map((result) => result.categoria))];
  const lines = [
    `## Rodada "${label}"`,
    "",
    `Modelo: ${model} (parâmetros da produção). Juiz: ${JUDGE_MODEL}. Custo: US$ ${spent.toFixed(3)}.${stopped ? " **Parou no teto de gasto: rodada incompleta.**" : ""}`,
    "",
    `**Acerto: ${passed}/${all.length} respostas (${((100 * passed) / Math.max(all.length, 1)).toFixed(0)}%). Nota média do juiz: ${avg(verdicts.map((v) => v.nota))}** (correção ${avg(verdicts.map((v) => v.correcao))}, não inventa ${avg(verdicts.map((v) => v.naoInventa))}, tom ${avg(verdicts.map((v) => v.tom))}, concisão ${avg(verdicts.map((v) => v.concisao))}).`,
    "",
    "| Categoria | Casos | Acerto | Nota |",
    "|---|--:|--:|--:|",
    ...categories.map((category) => {
      const group = results.filter((result) => result.categoria === category);
      const runs = group.flatMap((result) => result.runs);
      const ok = runs.filter((run) => !run.failures.length).length;
      return `| ${category} | ${group.length} | ${ok}/${runs.length} | ${avg(runs.flatMap((run) => (run.verdict ? [run.verdict.nota] : [])))} |`;
    }),
    "",
    "### Falhas",
    "",
  ];
  for (const result of results) {
    const failed = result.runs.filter((run) => run.failures.length || (run.verdict && run.verdict.nota <= 2));
    if (!failed.length) continue;
    lines.push(`**${result.id}** (${result.categoria}, ${result.runs.filter((run) => !run.failures.length).length}/${result.runs.length} ok). Esperado: ${result.nota}`);
    for (const run of failed) {
      const reply = run.reply ? `handoff ${run.reply.handoff}${run.reply.skip ? ", skip" : ""}: "${run.reply.reply.replace(/\n/g, " ")}"` : "sem resposta";
      lines.push(`- #${run.run + 1} ${reply}`);
      lines.push(`  - ${[...run.failures, ...(run.verdict ? [`juiz ${run.verdict.nota}: ${run.verdict.motivo}`] : [])].join("; ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

await main();
