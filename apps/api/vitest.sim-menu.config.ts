import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Evals do agente de pedidos com a API do Claude (pnpm sim:menu-agent). A chave vale só se veio do terminal: a do
// .env nunca liga a rodada sozinha (cada rodada custa). O banco e o Redis vêm do .env, como nos testes.
const fromShell = {
  AI_FALLBACK_API_KEY: process.env.AI_FALLBACK_API_KEY,
  AI_FALLBACK_BASE_URL: process.env.AI_FALLBACK_BASE_URL,
};
const rootEnv = new URL("../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
for (const [key, value] of Object.entries(fromShell)) {
  if (value) process.env[key] = value;
  else delete process.env[key];
}
process.env.AI_FALLBACK_PROVIDER = "anthropic";
process.env.CHANNELS_DRY_RUN = "true";

// Outro banco lógico do Redis, como nos testes (a trava e o teto de tokens não se misturam com os do dev).
if (process.env.REDIS_URL) {
  const redis = new URL(process.env.REDIS_URL);
  redis.pathname = "/15";
  process.env.REDIS_URL = redis.toString();
}

export default defineConfig({
  test: { include: ["sim/**/*.eval.ts"], silent: false, testTimeout: 3 * 60 * 60 * 1000, env: { LOG_LEVEL: "silent" } },
});
