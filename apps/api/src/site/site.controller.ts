import { createHmac } from "node:crypto";
import type { SiteDevice } from "@dishdesk/database/enums";
import { SiteVisitRequest } from "@dishdesk/shared";
import { Body, Controller, HttpCode, Inject, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { Public } from "../auth/auth.decorators.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";

/** Robôs que rodam JavaScript e chegariam ao script do site. */
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|bingpreview/i;
/** Eventos por visitante por minuto: acima disso não é uma pessoa navegando. */
const VISITOR_LIMIT = 60;

/** Sites de origem com o nome que a plataforma lê (o resto fica pelo endereço, sem "www."). */
const SOURCE_NAMES: [RegExp, string][] = [
  [/(^|\.)instagram\.com$/, "Instagram"],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "Facebook"],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, "WhatsApp"],
  [/(^|\.)google\.[a-z.]+$/, "Google"],
  [/(^|\.)bing\.com$/, "Bing"],
  [/(^|\.)duckduckgo\.com$/, "DuckDuckGo"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "YouTube"],
  [/(^|\.)linkedin\.com$|^lnkd\.in$/, "LinkedIn"],
  [/(^|\.)(tiktok\.com)$/, "TikTok"],
  [/^(t\.co|x\.com|twitter\.com)$/, "X"],
  [/(^|\.)chatgpt\.com$/, "ChatGPT"],
];

/**
 * Tráfego do site institucional: o script de `public/assets/track.js` manda cada página vista e cada clique em "Teste
 * grátis". Não usa cookie e não guarda o IP; a plataforma lê em /platform/traffic.
 */
@Controller("site")
export class SiteController {
  private readonly perVisitor = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Post("visits")
  @HttpCode(204)
  async visit(@Body(new ZodPipe(SiteVisitRequest)) body: SiteVisitRequest, @Req() request: Request): Promise<void> {
    const userAgent = request.headers["user-agent"] ?? "";
    if (!userAgent || BOT.test(userAgent)) return;
    const visitorId = this.visitorId(clientIp(request), userAgent);
    if (!this.allow(visitorId)) return;

    // createMany: sem RETURNING, que a RLS barraria (só a plataforma lê a tabela).
    await this.db.withTenants({ tenantIds: [] }, (tx) =>
      tx.siteVisit.createMany({
        data: {
          kind: body.kind === "cta" ? "CTA" : "PAGEVIEW",
          path: body.path.split(/[?#]/)[0] || "/",
          source: siteSource(body.utmSource, body.referrer),
          device: deviceOf(userAgent),
          visitorId,
        },
      }),
    );
  }

  /** Muda a cada dia (horário de Brasília): dá para contar visitantes do dia, não seguir uma pessoa. */
  private visitorId(ip: string, userAgent: string): string {
    const day = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return createHmac("sha256", this.env.JWT_SECRET).update(`site-visitor\n${day}\n${ip}\n${userAgent}`).digest("hex").slice(0, 32);
  }

  private allow(visitorId: string): boolean {
    const now = Date.now();
    if (this.perVisitor.size > 10_000) this.perVisitor.clear();
    const entry = this.perVisitor.get(visitorId);
    if (!entry || entry.resetAt <= now) {
      this.perVisitor.set(visitorId, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    entry.count += 1;
    return entry.count <= VISITOR_LIMIT;
  }
}

/** O navegador chega pela Railway e pelo proxy do painel (Next): o IP de quem acessou é o primeiro do X-Forwarded-For. */
function clientIp(request: Request): string {
  const forwarded = request.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || request.socket.remoteAddress || "";
}

/** utm_source manda; senão, o site de onde veio. Navegação dentro do próprio site não é origem. */
export function siteSource(utmSource: string | undefined, referrer: string | undefined): string | null {
  if (utmSource) return utmSource.toLowerCase() === "ig" ? "Instagram" : utmSource;
  if (!referrer) return null;
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (!host || host === "localhost" || host === "dishdesk.com.br" || host.endsWith(".dishdesk.com.br")) return null;
  return SOURCE_NAMES.find(([pattern]) => pattern.test(host))?.[1] ?? host;
}

export function deviceOf(userAgent: string): SiteDevice {
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(userAgent)) return "TABLET";
  if (/Mobi|iPhone|Android/i.test(userAgent)) return "MOBILE";
  return "DESKTOP";
}
