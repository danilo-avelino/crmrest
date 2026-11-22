import { withTenants } from "@dishdesk/database";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnthropicLlmProvider, type MessagesApi } from "../src/ai/llm-provider.js";
import type { Env } from "../src/config/env.js";
import { DatabaseService } from "../src/core/database.service.js";
import { OrderAgentService } from "../src/menu-agent/order-agent.service.js";
import type { RealtimeEmitter } from "../src/realtime/realtime.emitter.js";
import {
  checkTurn,
  type EvalEnv,
  loadEvals,
  RecordingProvider,
  renderReport,
  runScenario,
  type Scenario,
  TEMAS,
  withEvalStore,
} from "../sim/menu-agent-evals.js";
import { admin, createChannelFixture } from "./helpers.js";

const usage = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const text = (value: string) => ({ content: [{ type: "text", text: value }], stop_reason: "end_turn", usage });
const toolUse = (id: string, name: string, input: unknown) => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use", usage });

// Evals do agente de pedidos (F4-09): os arquivos seguem o formato e o runner confere um cenário com um modelo falso.
// Nenhuma chamada à API do Claude.
describe("evals do agente de pedidos (F4-09)", () => {
  it("os cenários de docs/cardapio-ia/evals seguem o formato e cobrem todos os temas", () => {
    const scenarios = loadEvals();
    expect(scenarios.length).toBeGreaterThanOrEqual(30);
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(scenarios.length);
    expect(new Set(scenarios.map((s) => s.tema))).toEqual(new Set(TEMAS));
    for (const scenario of scenarios) {
      expect(scenario.turnos.some((turn) => turn.espera), scenario.id).toBe(true);
      // As regex precisam compilar.
      for (const turn of scenario.turnos) for (const p of [...(turn.espera?.respostaContem ?? []), ...(turn.espera?.respostaNaoContem ?? [])]) new RegExp(p, "iu");
    }
  });

  it("checkTurn: meio a meio nas duas ordens, total na resposta e transferência", () => {
    const cart = { status: "DRAFT", itens: [{ nome: "Margherita", tamanho: "Grande", outraMetade: "Calabresa", quantidade: 1 }], total: { centavos: 5990, texto: "R$ 59,90" } };
    const turn = { reply: "Ficou R$ 59,90.", tools: ["adicionar_ao_carrinho"], cart, transferred: false };
    expect(checkTurn({ carrinho: { itens: [{ nome: "calabresa", outraMetade: "margherita", tamanho: "grande" }], exatamente: true, totalNaResposta: true } }, turn)).toEqual([]);
    expect(checkTurn({ transferencia: true, semFerramentas: ["adicionar_ao_carrinho"], respostaNaoContem: ["R\\$ ?59"] }, turn)).toEqual([
      "chamou adicionar_ao_carrinho, que não devia",
      "a resposta tem /R\\$ ?59/, que não devia",
      "não passou para a equipe",
    ]);
  });

  describe("runner com um modelo falso", () => {
    let fx: Awaited<ReturnType<typeof createChannelFixture>>;
    let env: EvalEnv;
    let agent: OrderAgentService;
    let db: DatabaseService;
    let ids: { calabresa: string; grande: string };
    let script: unknown[] = [];
    const api = { create: async () => script.shift() ?? text("sem roteiro") } as unknown as MessagesApi;

    beforeAll(async () => {
      fx = await createChannelFixture();
      await admin.tenantModule.create({ data: { tenantId: fx.tenant.id, module: "MENU" } });
      const menu = await admin.menu.create({ data: { tenantId: fx.tenant.id, name: "Cardápio" } });
      const category = await admin.menuCategory.create({ data: { tenantId: fx.tenant.id, menuId: menu.id, name: "Pizzas" } });
      const calabresa = await admin.menuItem.create({
        data: { tenantId: fx.tenant.id, categoryId: category.id, name: "Calabresa", sizes: { create: [{ tenantId: fx.tenant.id, name: "Grande", priceCents: 5990 }] } },
        include: { sizes: true },
      });
      ids = { calabresa: calabresa.id, grande: calabresa.sizes[0]!.id };
      const appEnv = { DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: process.env.REDIS_URL, MENU_AGENT_DAILY_TOKENS: 400_000 } as Env;
      db = new DatabaseService(appEnv);
      const recorder = new RecordingProvider(new AnthropicLlmProvider({} as Env, db, api));
      const noQueue = { add: async () => undefined } as unknown as Queue;
      agent = new OrderAgentService(db, { inboxChanged: () => undefined } as unknown as RealtimeEmitter, noQueue, noQueue, recorder, appEnv);
      env = { tenantId: fx.tenant.id, channelId: fx.whatsapp.id, admin, db: { withTenants: (scope, fn) => withTenants(db.client, scope, fn) }, agent, recorder };
    });

    afterAll(async () => {
      await agent?.onModuleDestroy();
      await db?.onModuleDestroy();
      await fx?.cleanup();
    });

    const scenario: Scenario = {
      id: "roteiro",
      titulo: "Calabresa grande e transferência",
      tema: "pedido-simples",
      turnos: [
        {
          cliente: "quero uma calabreza grandi",
          espera: {
            ferramentas: ["adicionar_ao_carrinho"],
            carrinho: { itens: [{ nome: "calabresa", tamanho: "grande", quantidade: 1 }], exatamente: true, totalNaResposta: true },
            transferencia: false,
          },
        },
        { cliente: "quero falar com uma pessoa", espera: { ferramentas: ["transferir_para_humano"], transferencia: true } },
      ],
    };

    it("roda o cenário no agente de verdade, confere cada turno e apaga a conversa", async () => {
      const settingsBefore = (await admin.tenant.findUniqueOrThrow({ where: { id: fx.tenant.id } })).settings;
      script = [
        toolUse("t1", "adicionar_ao_carrinho", { itemId: ids.calabresa, tamanhoId: ids.grande }),
        text("Anotei 1 Calabresa Grande: R$ 59,90."),
        toolUse("t2", "transferir_para_humano", { motivo: "Cliente pediu uma pessoa" }),
        text("Vou chamar alguém da equipe."),
      ];
      const result = await withEvalStore(admin, fx.tenant.id, () => runScenario(scenario, env));
      expect(result.failures).toEqual([]);
      expect(result.passed).toBe(true);
      expect(result.transcript.map((t) => t.ferramentas)).toEqual([["adicionar_ao_carrinho"], ["transferir_para_humano"]]);
      expect(result.transcript[1]!.transferiu).toBe(true);
      expect(await admin.conversation.count({ where: { tenantId: fx.tenant.id } })).toBe(0);
      expect((await admin.tenant.findUniqueOrThrow({ where: { id: fx.tenant.id } })).settings).toEqual(settingsBefore);

      // Modelo que inventa preço e não transfere: as falhas saem no relatório com a conversa.
      script = [text("A calabresa grande sai por R$ 7,77."), text("Sai por R$ 7,77 mesmo."), text("Claro, sigo eu mesmo.")];
      const failed = await withEvalStore(admin, fx.tenant.id, () => runScenario(scenario, env));
      expect(failed.passed).toBe(false);
      expect(failed.failures).toContain("turno 1: não chamou adicionar_ao_carrinho");
      expect(failed.failures).toContain("turno 2: não rodou, a conversa já estava com a equipe");
      const report = renderReport([[result, failed]], { model: "falso", when: new Date("2026-11-21T12:00:00Z") });
      expect(report).toContain("**Acerto geral: 1 de 2 (50%).**");
      expect(report).toContain("| roteiro | pedido-simples | 1/2 (50%) |");
      expect(report).toContain("> **Cliente:** quero uma calabreza grandi");
    });
  });
});
