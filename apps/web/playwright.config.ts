import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const rootEnv = path.join(__dirname, "../../.env");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// E2E contra os builds de produção (pnpm e2e compila antes). Usa o Edge instalado: nada para baixar.
export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  // Local: o Edge instalado (nada para baixar). CI: o Chromium do Playwright.
  use: { baseURL: "http://localhost:3100", channel: process.env.CI ? undefined : "msedge", viewport: { width: 1440, height: 900 } },
  webServer: [
    {
      command: "pnpm --filter @comanda/api start",
      url: "http://localhost:4000/api/health/ready",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "pnpm exec next start -p 3100",
      url: "http://localhost:3100/login",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
