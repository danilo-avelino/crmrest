import { decrypt, encrypt, parseEncryptionKey } from "@dishdesk/database";
import { menuStoreOf } from "@dishdesk/shared";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { withoutDemo } from "../demo/demo.js";
import { type CapiSource, capiEvent } from "./meta-capi.js";

/** Etapas na ordem da tabela da saúde; as duas últimas só o servidor manda. */
const CAPI_STAGES = ["PAGE_VIEW", "VIEW_CONTENT", "ADD_TO_CART", "INITIATE_CHECKOUT", "ADD_PAYMENT_INFO", "PURCHASE"] as const;
const SERVER_ONLY = new Set<string>(["ADD_PAYMENT_INFO", "PURCHASE"]);

/** Eventos por envio (a Meta aceita até 1000) e a janela que ela aceita (7 dias). */
const BATCH = 200;
const WINDOW_MS = 7 * 24 * 60 * 60_000;

/** Onde o token fica: `tenant.settings.metaCapi.tokenEnc` (AES-256-GCM com a ENCRYPTION_KEY, em base64). */
type MetaCapiSettings = { tokenEnc?: string; last4?: string };
export const metaCapiOf = (settings: unknown): MetaCapiSettings => {
  const value = settings && typeof settings === "object" ? (settings as { metaCapi?: unknown }).metaCapi : undefined;
  return value && typeof value === "object" ? (value as MetaCapiSettings) : {};
};

/**
 * Conversions API da Meta (F7-04). Uma varredura do worker, a cada minuto, manda os eventos do funil ainda não enviados
 * dos restaurantes com Pixel e token, com o mesmo `event_id` do Pixel. Enviado ou recusado pela Meta, o evento fica
 * marcado (`capiSentAt`, `capiError`); falha de rede ou 5xx tenta de novo na próxima volta. O token nunca vai para o log
 * nem para a URL.
 */
@Injectable()
export class MetaCapiService {
  private readonly logger = new Logger(MetaCapiService.name);
  private readonly key: Buffer;

  constructor(
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.key = parseEncryptionKey(env.ENCRYPTION_KEY);
  }

  /** O que guardar em `settings.metaCapi`; null apaga. */
  seal(token: string | null): MetaCapiSettings | null {
    if (!token) return null;
    return { tokenEnc: Buffer.from(encrypt(token, this.key)).toString("base64"), last4: token.slice(-4) };
  }

  private tokenOf(settings: unknown): string | null {
    const sealed = metaCapiOf(settings).tokenEnc;
    if (!sealed) return null;
    try {
      return decrypt(Buffer.from(sealed, "base64"), this.key);
    } catch {
      return null;
    }
  }

  async sweep(now = new Date()): Promise<void> {
    const tenants = await this.db.client.$queryRaw<{ tenant_id: string }[]>`SELECT tenant_id FROM app.capi_pending_tenants()`;
    for (const { tenant_id: tenantId } of await withoutDemo(this.db, tenants, (tenant) => tenant.tenant_id)) {
      try {
        await this.sendTenant(tenantId, now);
      } catch (error) {
        this.logger.warn(`CAPI do restaurante ${tenantId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async sendTenant(tenantId: string, now = new Date(), post: typeof fetch = fetch): Promise<void> {
    const scope = { tenantIds: [tenantId] };
    const loaded = await this.db.withTenants(scope, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true, settings: true } });
      const events = await tx.funnelEvent.findMany({
        where: { tenantId, capiSentAt: null, createdAt: { gt: new Date(now.getTime() - WINDOW_MS) } },
        orderBy: { createdAt: "asc" },
        take: BATCH,
      });
      const contactIds = [...new Set(events.map((e) => e.contactId).filter((id): id is string => !!id))];
      const contacts = contactIds.length ? await tx.contact.findMany({ where: { tenantId, id: { in: contactIds } }, select: { id: true, phone: true } }) : [];
      return { tenant, events, phones: new Map(contacts.map((c) => [c.id, c.phone])) };
    });
    const pixelId = menuStoreOf(loaded.tenant.settings).metaPixelId;
    const token = this.tokenOf(loaded.tenant.settings);
    if (!pixelId || !token || loaded.events.length === 0) return;
    const url = `${this.env.WEB_ORIGIN}/c/${encodeURIComponent(loaded.tenant.slug)}`;

    const skipped: { id: string; reason: string }[] = [];
    const ready: { id: string; event: Record<string, unknown> }[] = [];
    for (const row of loaded.events) {
      const source: CapiSource = {
        eventId: row.eventId,
        stage: row.stage,
        channel: row.channel,
        orderId: row.orderId,
        contactId: row.contactId,
        valueCents: row.valueCents,
        attribution: (row.attribution ?? {}) as Record<string, string>,
        createdAt: row.createdAt,
        phone: row.contactId ? (loaded.phones.get(row.contactId) ?? null) : null,
      };
      const built = capiEvent(source, url);
      if ("skip" in built) skipped.push({ id: row.id, reason: built.skip });
      else ready.push({ id: row.id, event: built.event });
    }

    const mark = (ids: string[], error: string | null) =>
      ids.length ? this.db.withTenants(scope, (tx) => tx.funnelEvent.updateMany({ where: { tenantId, id: { in: ids } }, data: { capiSentAt: now, capiError: error } })) : null;
    for (const reason of new Set(skipped.map((s) => s.reason))) await mark(skipped.filter((s) => s.reason === reason).map((s) => s.id), reason);
    if (!ready.length) return;

    const testCode = menuStoreOf(loaded.tenant.settings).metaTestEventCode;
    let response: Response;
    try {
      response = await post(`${this.env.META_GRAPH_URL}/${encodeURIComponent(pixelId)}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: ready.map((r) => r.event), access_token: token, ...(testCode ? { test_event_code: testCode } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      this.logger.warn(`CAPI sem resposta (restaurante ${tenantId}): ${error instanceof Error ? error.message : String(error)}`);
      return; // tenta de novo na próxima volta
    }
    if (response.status >= 500) return;
    if (response.ok) {
      await mark(
        ready.map((r) => r.id),
        null,
      );
      return;
    }
    const body = (await response.json().catch(() => null)) as { error?: { message?: string; code?: number } } | null;
    const message = `Meta ${response.status}: ${body?.error?.message ?? "recusou os eventos"}`.slice(0, 300);
    this.logger.warn(`CAPI recusada (restaurante ${tenantId}): ${message}`);
    await mark(
      ready.map((r) => r.id),
      message,
    );
  }

  /**
   * Saúde (F7-08) no período: por etapa, os eventos do site com consentimento (o Pixel também os dispara, com o mesmo
   * id), os enviados pelo servidor, os recusados pela Meta e o último envio. O número principal é a parte dos eventos
   * do navegador que também saíram pelo servidor (o par que a Meta deduplica).
   */
  async health(tenantId: string, hours = 24, now = new Date()) {
    return this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const since = new Date(now.getTime() - hours * 60 * 60_000);
      const rows = await tx.$queryRaw<{ stage: string; consented: bigint; sent: bigint; failed: bigint; last_sent: Date | null }[]>`
        SELECT stage::text AS stage,
          count(*) FILTER (WHERE channel = 'WEB' AND attribution ->> 'ads_consent' = 'granted') AS consented,
          count(*) FILTER (WHERE capi_sent_at IS NOT NULL AND capi_error IS NULL) AS sent,
          count(*) FILTER (WHERE capi_error LIKE 'Meta%') AS failed,
          max(capi_sent_at) FILTER (WHERE capi_error IS NULL) AS last_sent
        FROM funnel_events
        WHERE tenant_id = ${tenantId}::uuid AND created_at >= ${since}
        GROUP BY stage`;
      const lastError = await tx.funnelEvent.findFirst({
        where: { tenantId, createdAt: { gte: since }, capiError: { startsWith: "Meta" } },
        orderBy: { capiSentAt: "desc" },
        select: { capiError: true, capiSentAt: true },
      });
      const pending = await tx.funnelEvent.count({ where: { tenantId, createdAt: { gte: since }, capiSentAt: null } });
      const stages = CAPI_STAGES.map((stage) => {
        const row = rows.find((r) => r.stage === stage);
        return {
          stage,
          /** null nas etapas que só o servidor manda (ADD_PAYMENT_INFO e PURCHASE). */
          browser: SERVER_ONLY.has(stage) ? null : Number(row?.consented ?? 0),
          server: Number(row?.sent ?? 0),
          failed: Number(row?.failed ?? 0),
          lastSentAt: row?.last_sent?.toISOString() ?? null,
        };
      });
      const browserTotal = stages.reduce((sum, s) => sum + (s.browser ?? 0), 0);
      const pairedTotal = stages.reduce((sum, s) => sum + (s.browser == null ? 0 : Math.min(s.server, s.browser)), 0);
      return {
        hours,
        pairedPercent: browserTotal > 0 ? Math.round((pairedTotal / browserTotal) * 100) : null,
        stages,
        pending,
        lastError: lastError ? { message: lastError.capiError!, at: lastError.capiSentAt?.toISOString() ?? null } : null,
      };
    });
  }
}
