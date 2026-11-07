import { z } from "zod";

// Tráfego do site institucional (www.dishdesk.com.br): visitas medidas pelo próprio Dish Desk, sem cookies e sem guardar
// o IP. O visitante é um hash do dia + IP + navegador, que muda a cada dia.

/** O que o script do site manda: uma página vista ou um clique em "Teste grátis" (link para /cadastro). */
export const SiteVisitRequest = z.object({
  kind: z.enum(["pageview", "cta"]),
  path: z.string().trim().startsWith("/").max(200),
  referrer: z.string().trim().max(500).optional(),
  utmSource: z.string().trim().max(100).optional(),
});
export type SiteVisitRequest = z.infer<typeof SiteVisitRequest>;

export const TRAFFIC_PERIODS = [7, 30, 90] as const;
export type TrafficPeriod = (typeof TRAFFIC_PERIODS)[number];

export const DEVICE_LABEL = { desktop: "Computador", mobile: "Celular", tablet: "Tablet" } as const;
export type SiteDevice = keyof typeof DEVICE_LABEL;

/** Origem sem referência nem utm_source: link digitado, salvo ou aberto num app que não informa de onde veio. */
export const DIRECT_SOURCE = "Direto";

export type TrafficTotals = { pageviews: number; visitors: number; ctaClicks: number; signups: number };

/** Tráfego dos últimos `days` dias (horário de Brasília), com o período anterior de mesmo tamanho para comparar. */
export type PlatformTrafficDto = {
  days: TrafficPeriod;
  totals: TrafficTotals;
  previous: TrafficTotals;
  /** Um item por dia do período, inclusive os sem visita (AAAA-MM-DD). */
  daily: { date: string; pageviews: number; visitors: number }[];
  pages: { path: string; pageviews: number; visitors: number }[];
  sources: { source: string; visitors: number }[];
  devices: { device: SiteDevice; visitors: number }[];
  /** Visualizações por hora do dia, de 0h a 23h. */
  hours: number[];
  insights: string[];
};

const percent = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 1 });
const number = new Intl.NumberFormat("pt-BR");

function share(part: number, whole: number): string {
  return percent.format(whole === 0 ? 0 : part / whole);
}

function shortDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${day}/${month}`;
}

/** Conclusões em frases curtas a partir dos números do período, da mais importante para a menos. */
export function trafficInsights(data: Omit<PlatformTrafficDto, "insights">): string[] {
  const { totals, previous, days } = data;
  if (totals.visitors === 0) return [`Nenhuma visita medida nos últimos ${days} dias.`];
  const insights: string[] = [];

  if (previous.visitors > 0) {
    const change = (totals.visitors - previous.visitors) / previous.visitors;
    if (Math.abs(change) < 0.05) {
      insights.push(`Os visitantes ficaram estáveis em relação aos ${days} dias anteriores (${number.format(totals.visitors)}).`);
    } else {
      const verb = change > 0 ? "subiram" : "caíram";
      insights.push(
        `Os visitantes ${verb} ${percent.format(Math.abs(change))} em relação aos ${days} dias anteriores ` +
          `(${number.format(previous.visitors)} → ${number.format(totals.visitors)}).`,
      );
    }
  }

  insights.push(
    totals.signups === 0
      ? `Nenhum cadastro de teste grátis no período, com ${number.format(totals.visitors)} visitantes.`
      : `${share(totals.signups, totals.visitors)} dos visitantes fizeram o cadastro do teste grátis ` +
          `(${number.format(totals.signups)} de ${number.format(totals.visitors)}).`,
  );
  if (totals.ctaClicks > 0 && totals.signups < totals.ctaClicks / 2) {
    insights.push(
      `${number.format(totals.ctaClicks)} cliques em "Teste grátis" e ${number.format(totals.signups)} cadastros: ` +
        "muita gente abre o cadastro e desiste no meio.",
    );
  }

  const [top] = data.sources;
  if (top) {
    insights.push(
      top.source === DIRECT_SOURCE
        ? `${share(top.visitors, totals.visitors)} chegaram direto, sem origem informada (link digitado, salvo ou aberto num app).`
        : `${top.source} é a origem que mais traz visitantes: ${share(top.visitors, totals.visitors)}.`,
    );
  }

  const mobile = data.devices.find((row) => row.device === "mobile")?.visitors ?? 0;
  if (mobile / totals.visitors >= 0.5) {
    insights.push(`${share(mobile, totals.visitors)} das visitas são pelo celular: confira o site primeiro no celular.`);
  }

  const peak = data.hours.reduce((best, views, hour) => (views > (data.hours[best] ?? 0) ? hour : best), 0);
  if ((data.hours[peak] ?? 0) > 0) insights.push(`O horário com mais visitas é das ${peak}h às ${(peak + 1) % 24}h.`);

  const best = data.daily.reduce((a, b) => (b.visitors > a.visitors ? b : a));
  if (days > 7 && best.visitors > 0) {
    insights.push(`O dia com mais visitantes foi ${shortDate(best.date)} (${number.format(best.visitors)}).`);
  }
  return insights;
}
