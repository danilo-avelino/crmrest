import { Prisma, type TenantTx } from "@dishdesk/database";
import { Injectable } from "@nestjs/common";

export type FunnelStage = "PAGE_VIEW" | "VIEW_CONTENT" | "SEARCH" | "ADD_TO_CART" | "INITIATE_CHECKOUT" | "ADD_PAYMENT_INFO" | "PURCHASE";
export type FunnelChannel = "WEB" | "WHATSAPP";

/** Etapas do funil em ordem (SEARCH fica fora: é uma ação lateral, não um degrau). */
export const FUNNEL_STEPS = ["PAGE_VIEW", "VIEW_CONTENT", "ADD_TO_CART", "INITIATE_CHECKOUT", "ADD_PAYMENT_INFO", "PURCHASE"] as const satisfies readonly FunnelStage[];

/** Etapas que o navegador pode informar. ADD_PAYMENT_INFO e PURCHASE só o servidor grava (nunca confiar no cliente). */
export const BROWSER_STAGES = ["PAGE_VIEW", "VIEW_CONTENT", "SEARCH", "ADD_TO_CART", "INITIATE_CHECKOUT"] as const;

export type FunnelEventInput = {
  /** Id de deduplicação (também usado depois com a Meta). Único por restaurante. */
  eventId: string;
  stage: FunnelStage;
  channel: FunnelChannel;
  sessionId?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  cartId?: string | null;
  orderId?: string | null;
  menuItemId?: string | null;
  valueCents?: number | null;
  /** utm_*, fbclid, fbc, fbp, referrer, ctwa_clid. */
  attribution?: Record<string, string>;
};

export type FunnelRange = { from: Date; to: Date; channel?: FunnelChannel };

export type FunnelStepSummary = {
  stage: FunnelStage;
  /** Eventos gravados na etapa. */
  events: number;
  /** Visitantes distintos (sessão, senão contato, senão carrinho). É a base da conversão. */
  visitors: number;
  /** visitors / visitors da etapa anterior (null na primeira etapa ou com a anterior zerada). */
  fromPrevious: number | null;
  /** visitors / visitors da primeira etapa (null na primeira ou com ela zerada). */
  fromFirst: number | null;
};

export type FunnelSummary = { steps: FunnelStepSummary[]; searches: number };

const ratio = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10_000) / 10_000 : null);

// Visitante da linha: sessão do navegador, senão contato (WhatsApp), senão carrinho, senão o próprio evento.
const SUBJECT = Prisma.sql`COALESCE(session_id, contact_id::text, cart_id::text, event_id::text)`;

/** Funil de vendas do cardápio (F7-01): gravado no backend, funciona mesmo com o Pixel bloqueado. */
@Injectable()
export class FunnelService {
  /** Grava o evento. Repetir o mesmo eventId não duplica: devolve false. */
  async record(tx: TenantTx, tenantId: string, event: FunnelEventInput): Promise<boolean> {
    const created = await tx.funnelEvent.createMany({
      data: [
        {
          tenantId,
          eventId: event.eventId,
          stage: event.stage,
          channel: event.channel,
          sessionId: event.sessionId ?? null,
          contactId: event.contactId ?? null,
          conversationId: event.conversationId ?? null,
          cartId: event.cartId ?? null,
          orderId: event.orderId ?? null,
          menuItemId: event.menuItemId ?? null,
          valueCents: event.valueCents ?? null,
          attribution: event.attribution ?? {},
        },
      ],
      skipDuplicates: true,
    });
    return created.count > 0;
  }

  /** Contagem por etapa e conversão entre etapas no período [from, to). */
  async summary(tx: TenantTx, tenantId: string, range: FunnelRange): Promise<FunnelSummary> {
    const channel = range.channel ? Prisma.sql`AND channel = ${range.channel}::"FunnelChannel"` : Prisma.empty;
    const rows = await tx.$queryRaw<{ stage: FunnelStage; events: bigint; visitors: bigint }[]>`
      SELECT stage::text AS stage, count(*) AS events, count(DISTINCT ${SUBJECT}) AS visitors
      FROM funnel_events
      WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${range.from} AND created_at < ${range.to} ${channel}
      GROUP BY stage`;
    const byStage = new Map(rows.map((r) => [r.stage, { events: Number(r.events), visitors: Number(r.visitors) }]));
    const first = byStage.get(FUNNEL_STEPS[0])?.visitors ?? 0;
    let previous: number | null = null;
    const steps = FUNNEL_STEPS.map((stage) => {
      const { events, visitors } = byStage.get(stage) ?? { events: 0, visitors: 0 };
      const step: FunnelStepSummary = {
        stage,
        events,
        visitors,
        fromPrevious: previous === null ? null : ratio(visitors, previous),
        fromFirst: previous === null ? null : ratio(visitors, first),
      };
      previous = visitors;
      return step;
    });
    return { steps, searches: byStage.get("SEARCH")?.events ?? 0 };
  }

  /** Visitantes por etapa quebrados por origem (utm_source, senão referrer, senão "direto"). */
  async bySource(tx: TenantTx, tenantId: string, range: FunnelRange) {
    const channel = range.channel ? Prisma.sql`AND channel = ${range.channel}::"FunnelChannel"` : Prisma.empty;
    const rows = await tx.$queryRaw<{ source: string; stage: FunnelStage; visitors: bigint }[]>`
      SELECT COALESCE(NULLIF(attribution->>'utm_source', ''), NULLIF(attribution->>'referrer', ''), 'direto') AS source,
             stage::text AS stage, count(DISTINCT ${SUBJECT}) AS visitors
      FROM funnel_events
      WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${range.from} AND created_at < ${range.to} ${channel}
      GROUP BY 1, stage`;
    return rows.map((r) => ({ source: r.source, stage: r.stage, visitors: Number(r.visitors) }));
  }
}
