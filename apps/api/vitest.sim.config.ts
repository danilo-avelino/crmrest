import { defineConfig } from "vitest/config";

// Simulações com a LLM de verdade (sem banco nem Redis): pnpm sim:agent
export default defineConfig({
  test: { include: ["sim/**/*.sim.ts"], env: { LOG_LEVEL: "silent", SIM_AGENT: "1" } },
});
