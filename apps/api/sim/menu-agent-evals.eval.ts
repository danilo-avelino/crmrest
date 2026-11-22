// Roda as evals do agente de pedidos (F4-09) no restaurante "Forno da Vila" do seed, com a API do Claude de verdade,
// e grava docs/cardapio-ia/evals/RESULTADOS.md. Sem AI_FALLBACK_API_KEY no terminal, só explica como rodar.
// Nada sai para o WhatsApp: as filas são falsas. As conversas criadas são apagadas no fim de cada cenário.
//   SIM_RUNS=3       rodadas por cenário (padrão 1)
//   SIM_ONLY=a,b     só esses cenários (ids)
import { writeFileSync } from "node:fs";
import { createPrismaClient } from "@dishdesk/database";
import type { Queue } from "bullmq";
import { describe, it } from "vitest";
import { AnthropicLlmProvider, LLM_PROVIDER_MODEL } from "../src/ai/llm-provider.js";
import { loadEnv } from "../src/config/env.js";
import { DatabaseService } from "../src/core/database.service.js";
import { OrderAgentService } from "../src/menu-agent/order-agent.service.js";
import type { RealtimeEmitter } from "../src/realtime/realtime.emitter.js";
import { EVALS_DIR, loadEvals, RecordingProvider, renderReport, runScenario, type ScenarioResult, withEvalStore } from "./menu-agent-evals.js";

const HOW_TO = `Evals do agente de pedidos: nada rodou, falta a chave da API do Claude no terminal (a do .env não vale aqui).
Cada rodada chama a API de verdade e custa. Para rodar (PowerShell, na raiz do projeto, com o Docker e o seed):
  $env:AI_FALLBACK_API_KEY = "<sua chave>"; pnpm --filter api sim:menu-agent
Opcional: $env:SIM_RUNS = "3" (rodadas por cenário), $env:SIM_ONLY = "pedido-simples-calabresa,meio-a-meio-calabresa-margherita".
O relatório sai em docs/cardapio-ia/evals/RESULTADOS.md.`;

describe("evals do agente de pedidos (F4-09)", () => {
  it("roda os cenários e grava o relatório", async () => {
    if (!process.env.AI_FALLBACK_API_KEY) {
      console.log(HOW_TO);
      return;
    }
    const only = new Set((process.env.SIM_ONLY ?? "").split(",").map((id) => id.trim()).filter(Boolean));
    const scenarios = loadEvals().filter((scenario) => !only.size || only.has(scenario.id));
    const runs = Math.max(1, Number(process.env.SIM_RUNS ?? 1));

    const env = loadEnv();
    const admin = createPrismaClient(process.env.DATABASE_ADMIN_URL ?? "");
    const db = new DatabaseService(env);
    const recorder = new RecordingProvider(new AnthropicLlmProvider(env, db));
    const noQueue = { add: async () => undefined } as unknown as Queue;
    const noRealtime = { inboxChanged: () => undefined } as unknown as RealtimeEmitter;
    const agent = new OrderAgentService(db, noRealtime, noQueue, noQueue, recorder, env);
    try {
      const tenant = await admin.tenant.findUnique({
        where: { slug: "forno-da-vila" },
        select: { id: true, menus: { select: { active: true } }, modules: { where: { module: "MENU" }, select: { id: true } } },
      });
      if (!tenant?.menus[0]?.active || !tenant.modules.length) throw new Error('O restaurante "Forno da Vila" do seed não existe ou está sem cardápio: rode pnpm db:seed.');
      const channel = await admin.channel.findFirstOrThrow({ where: { tenantId: tenant.id, type: "WHATSAPP" }, select: { id: true } });

      const results: ScenarioResult[][] = [];
      await withEvalStore(admin, tenant.id, async () => {
        for (let run = 0; run < runs; run++) {
          const round: ScenarioResult[] = [];
          for (const scenario of scenarios) {
            const result = await runScenario(scenario, { tenantId: tenant.id, channelId: channel.id, admin, db, agent, recorder });
            console.log(`${result.passed ? "ok  " : "FALHOU"} ${scenario.id}${result.passed ? "" : `: ${result.failures.join("; ")}`}`);
            round.push(result);
          }
          results.push(round);
        }
      });
      const report = renderReport(results, { model: LLM_PROVIDER_MODEL, when: new Date() });
      writeFileSync(new URL("RESULTADOS.md", EVALS_DIR), report);
      console.log(report.split("\n").find((line) => line.startsWith("**Acerto geral")));
    } finally {
      await agent.onModuleDestroy();
      await db.onModuleDestroy();
      await admin.$disconnect();
    }
  });
});
