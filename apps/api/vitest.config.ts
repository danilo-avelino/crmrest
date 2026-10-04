import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

const rootEnv = new URL("../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// Outro banco lógico do Redis: filas e eventos dos testes não se misturam com os do servidor de dev.
if (process.env.REDIS_URL) {
  const redis = new URL(process.env.REDIS_URL);
  redis.pathname = "/15";
  process.env.REDIS_URL = redis.toString();
}

export default defineConfig({
  test: {
    // Os testes de integração compartilham o banco e o Redis locais.
    fileParallelism: false,
    testTimeout: 20_000,
    env: { LOG_LEVEL: "silent" },
    hookTimeout: 30_000,
  },
});
