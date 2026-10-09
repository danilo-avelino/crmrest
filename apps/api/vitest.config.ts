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

// Credenciais reais do iFood no .env não valem nos testes (eles usam uma API falsa e passam as próprias).
for (const key of ["IFOOD_CLIENT_ID", "IFOOD_CLIENT_SECRET", "IFOOD_WIDGET_ID"]) delete process.env[key];
// O mesmo vale para o Cardápio Web de produção e o envio real: o banco é o mesmo do dev, com lojas e clientes reais.
delete process.env.CARDAPIO_WEB_API_URL;
process.env.CHANNELS_DRY_RUN = "true";

export default defineConfig({
  test: {
    // Os testes de integração compartilham o banco e o Redis locais.
    fileParallelism: false,
    testTimeout: 20_000,
    env: { LOG_LEVEL: "silent" },
    hookTimeout: 30_000,
  },
});
