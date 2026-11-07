import { describe, expect, it } from "vitest";
import { type PlatformTrafficDto, trafficInsights } from "../src/index.js";

const empty = { pageviews: 0, visitors: 0, ctaClicks: 0, signups: 0 };

function traffic(overrides: Partial<Omit<PlatformTrafficDto, "insights">> = {}): Omit<PlatformTrafficDto, "insights"> {
  return {
    days: 7,
    totals: { pageviews: 300, visitors: 200, ctaClicks: 20, signups: 4 },
    previous: { pageviews: 200, visitors: 100, ctaClicks: 10, signups: 1 },
    daily: [
      { date: "2026-11-06", pageviews: 100, visitors: 80 },
      { date: "2026-11-07", pageviews: 200, visitors: 120 },
    ],
    pages: [{ path: "/", pageviews: 250, visitors: 190 }],
    sources: [
      { source: "Instagram", visitors: 110 },
      { source: "Direto", visitors: 90 },
    ],
    devices: [
      { device: "mobile", visitors: 140 },
      { device: "desktop", visitors: 60 },
    ],
    hours: Array.from({ length: 24 }, (_, hour) => (hour === 19 ? 50 : 5)),
    ...overrides,
  };
}

describe("conclusões do tráfego do site", () => {
  it("compara com o período anterior, mostra a conversão, a origem, o celular e o pico", () => {
    expect(trafficInsights(traffic())).toEqual([
      "Os visitantes subiram 100% em relação aos 7 dias anteriores (100 → 200).",
      "2% dos visitantes fizeram o cadastro do teste grátis (4 de 200).",
      '20 cliques em "Teste grátis" e 4 cadastros: muita gente abre o cadastro e desiste no meio.',
      "Instagram é a origem que mais traz visitantes: 55%.",
      "70% das visitas são pelo celular: confira o site primeiro no celular.",
      "O horário com mais visitas é das 19h às 20h.",
    ]);
  });

  it("sem visitas, diz só isso", () => {
    expect(trafficInsights(traffic({ totals: empty, sources: [], devices: [], hours: Array(24).fill(0) }))).toEqual([
      "Nenhuma visita medida nos últimos 7 dias.",
    ]);
  });

  it("estável, chegada direta e o melhor dia nos períodos longos", () => {
    const insights = trafficInsights(
      traffic({
        days: 30,
        totals: { pageviews: 120, visitors: 102, ctaClicks: 0, signups: 0 },
        previous: { pageviews: 110, visitors: 100, ctaClicks: 0, signups: 0 },
        sources: [{ source: "Direto", visitors: 102 }],
        devices: [{ device: "desktop", visitors: 102 }],
      }),
    );
    expect(insights).toContain("Os visitantes ficaram estáveis em relação aos 30 dias anteriores (102).");
    expect(insights).toContain("Nenhum cadastro de teste grátis no período, com 102 visitantes.");
    expect(insights).toContain("100% chegaram direto, sem origem informada (link digitado, salvo ou aberto num app).");
    expect(insights).toContain("O dia com mais visitantes foi 07/11 (120).");
    expect(insights.some((line) => line.includes("celular"))).toBe(false);
  });
});
