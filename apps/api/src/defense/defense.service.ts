import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { BlockList } from "node:net";
import { DEFENSE_REASON_LABEL, type DefenseAnalysisDto, type DefenseEventDto, type DefenseReason } from "@dishdesk/shared";
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { Request } from "express";
import { Redis } from "ioredis";
import { KEY_PREFIX } from "../auth/login-limits.service.js";
import { ENV, type Env } from "../config/env.js";
import {
  AUTH_LIMIT,
  AUTH_SUSPECT,
  AUTH_WINDOW_MS,
  BAN_MS,
  clientIp,
  CONFIRMED_BAN_MS,
  isFailedLogin,
  MANUAL_BAN_MS,
  NOT_FOUND_LIMIT,
  NOT_FOUND_WINDOW_MS,
  neverBanList,
  routePattern,
} from "./defense.rules.js";
import { JevClient } from "./jev.client.js";

/** Casos guardados (os mais antigos saem), por quanto tempo, e por quanto tempo uma conclusão do Jev é reaproveitada. */
const EVENTS_LIMIT = 500;
const EVENT_TTL_S = 30 * 24 * 60 * 60;
const VERDICT_TTL_S = 7 * 24 * 60 * 60;
/** Pedidos recusados de cada IP que o Jev vê ao analisar. */
const RECENT_LIMIT = 30;

const P = `${KEY_PREFIX}defense:`;
const EVENTS = `${P}events`;
const key = {
  ban: (ip: string) => `${P}ban:${ip}`,
  notFound: (ip: string) => `${P}404:${ip}`,
  auth: (ip: string) => `${P}auth:${ip}`,
  emails: (ip: string) => `${P}emails:${ip}`,
  suspect: (ip: string) => `${P}suspect:${ip}`,
  watch: (ip: string, reason: DefenseReason) => `${P}watch:${reason}:${ip}`,
  recent: (ip: string) => `${P}recent:${ip}`,
  event: (id: string) => `${P}event:${id}`,
  verdict: (signature: string) => `${P}verdict:${signature}`,
};

type StoredEvent = Omit<DefenseEventDto, "active">;

/**
 * Defesa da API, no Redis (vale em todas as réplicas): as regras banem o IP na hora, com prazo, e o Jev analisa cada
 * caso depois, fora do caminho do pedido. Com o ataque confirmado, o banimento passa a 7 dias; na suspeita de abuso
 * de login, a plataforma decide pelo painel. Redis fora do ar: a API segue sem a defesa.
 */
@Injectable()
export class DefenseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DefenseService.name);
  private readonly redis: Redis;
  private readonly neverBan: BlockList;
  /** DEFENSE_MODE=watch: as regras só registram o que teriam banido. */
  private readonly watchOnly: boolean;

  constructor(
    @Inject(ENV) env: Env,
    private readonly jev: JevClient,
  ) {
    // Sem fila offline e com prazo curto: com o Redis fora, o pedido passa na hora em vez de esperar.
    this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 1_000 });
    this.redis.on("error", () => {});
    this.neverBan = neverBanList(env.DEFENSE_ALLOW_IPS);
    this.watchOnly = env.DEFENSE_MODE === "watch";
  }

  /** O IP do pedido, ou null se a defesa nunca age sobre ele (rede interna, Fastly, DEFENSE_ALLOW_IPS). */
  ipOf(req: Request): string | null {
    return clientIp(req, this.neverBan);
  }

  async onModuleInit(): Promise<void> {
    if (this.redis.status !== "ready") await Promise.race([once(this.redis, "ready"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => {});
  }

  async isBanned(ip: string): Promise<boolean> {
    try {
      return (await this.redis.exists(key.ban(ip))) === 1;
    } catch {
      return false;
    }
  }

  /** Banimento por regra (o pedido já mostra o ataque, como a sondagem de um .env). */
  async ban(ip: string, req: Request, reason: DefenseReason): Promise<void> {
    await this.open(ip, req, reason, "banned").catch((error) => this.logger.warn(`Defesa: não abriu o caso de ${ip}: ${error}`));
  }

  /** Um pedido recusado (status 400+): conta para a varredura de rotas e para o abuso de login. */
  async observe(ip: string, req: Request, status: number): Promise<void> {
    try {
      const route = routePattern(req.path);
      await this.redis
        .multi()
        .lpush(key.recent(ip), `${req.method} ${route} ${status}`)
        .ltrim(key.recent(ip), 0, RECENT_LIMIT - 1)
        .pexpire(key.recent(ip), AUTH_WINDOW_MS)
        .exec();

      if (status === 404) {
        const [, [, distinct]] = (await this.redis
          .multi()
          .sadd(key.notFound(ip), route)
          .scard(key.notFound(ip))
          .pexpire(key.notFound(ip), NOT_FOUND_WINDOW_MS, "NX")
          .exec()) as [unknown, [Error | null, number]];
        if (distinct >= NOT_FOUND_LIMIT) await this.open(ip, req, "endpoint_enumeration", "banned");
        return;
      }

      if (isFailedLogin(req.method, req.path, status)) {
        const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
        const multi = this.redis.multi().incr(key.auth(ip)).pexpire(key.auth(ip), AUTH_WINDOW_MS, "NX");
        // Só o resumo do e-mail: o Jev recebe a quantidade de e-mails diferentes, nunca os e-mails.
        if (email) multi.sadd(key.emails(ip), sha256(email).slice(0, 16)).pexpire(key.emails(ip), AUTH_WINDOW_MS, "NX");
        const [[, failures]] = (await multi.exec()) as [[Error | null, number]];
        if (failures >= AUTH_LIMIT) {
          await this.open(ip, req, "auth_abuse", "banned");
        } else if (failures >= AUTH_SUSPECT) {
          // Uma suspeita por janela: o IP que segue errando não abre um caso por tentativa.
          if (await this.redis.set(key.suspect(ip), "1", "PX", AUTH_WINDOW_MS, "NX")) await this.open(ip, req, "auth_abuse", "suspected");
        }
      }
    } catch (error) {
      this.logger.warn(`Defesa: não registrou o pedido de ${ip}: ${String(error)}`);
    }
  }

  /** Os casos mais recentes primeiro, dizendo se o banimento de cada um vale agora. */
  async list(limit = 200): Promise<DefenseEventDto[]> {
    const ids = await this.redis.lrange(EVENTS, 0, limit - 1);
    if (!ids.length) return [];
    const events = (await this.redis.mget(ids.map(key.event))).flatMap((raw) => (raw ? [JSON.parse(raw) as StoredEvent] : []));
    if (!events.length) return [];
    const bans = await this.redis.mget(events.map((event) => key.ban(event.ip)));
    return events.map((event, index) => ({ ...event, active: bans[index] === event.id }));
  }

  /** Tira o banimento do caso e zera as contas do IP. null: caso não encontrado. */
  async unban(id: string): Promise<DefenseEventDto | null> {
    const event = await this.event(id);
    if (!event) return null;
    if ((await this.redis.get(key.ban(event.ip))) === id) await this.redis.del(key.ban(event.ip));
    const watched = (Object.keys(DEFENSE_REASON_LABEL) as DefenseReason[]).map((reason) => key.watch(event.ip, reason));
    await this.redis.del(key.notFound(event.ip), key.auth(event.ip), key.emails(event.ip), key.suspect(event.ip), key.recent(event.ip), ...watched);
    return this.save({ ...event, unbannedAt: new Date().toISOString() });
  }

  /** Bane à mão o IP de um caso (a suspeita de abuso de login que o Jev confirmou, por exemplo). */
  async banManually(id: string): Promise<DefenseEventDto | null> {
    const event = await this.event(id);
    if (!event) return null;
    await this.redis.set(key.ban(event.ip), id, "PX", MANUAL_BAN_MS);
    return this.save({ ...event, action: "banned", bannedUntil: new Date(Date.now() + MANUAL_BAN_MS).toISOString(), unbannedAt: null });
  }

  private async open(ip: string, req: Request, reason: DefenseReason, rule: "banned" | "suspected"): Promise<void> {
    // Em DEFENSE_MODE=watch, o que a regra banaria fica só registrado ("watched").
    const action: StoredEvent["action"] = rule === "banned" && this.watchOnly ? "watched" : rule;
    const userAgent = req.headers["user-agent"]?.slice(0, 200) ?? null;
    const event: StoredEvent = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ip,
      method: req.method,
      path: req.path.slice(0, 200),
      userAgent,
      reason,
      action,
      bannedUntil: action === "banned" ? new Date(Date.now() + BAN_MS[reason]).toISOString() : null,
      unbannedAt: null,
      analysis: this.jev.enabled ? { state: "pending" } : { state: "off" },
    };
    // Só um caso por banimento: os pedidos que chegam juntos (o robô manda vários de uma vez) não abrem outros.
    if (action === "banned" && !(await this.redis.set(key.ban(ip), event.id, "PX", BAN_MS[reason], "NX"))) return;
    // Sem banimento, o robô que segue sondando abriria um caso por pedido: um por regra e IP dentro do mesmo prazo.
    if (action === "watched" && !(await this.redis.set(key.watch(ip, reason), event.id, "PX", BAN_MS[reason], "NX"))) return;
    const multi = this.redis.multi();
    // O pedido que disparou a regra entra no que o Jev vê (a sondagem é recusada antes de chegar na contagem).
    if (reason === "sensitive_probe") multi.lpush(key.recent(ip), `${req.method} ${routePattern(req.path)} 404`).pexpire(key.recent(ip), AUTH_WINDOW_MS);
    await multi.set(key.event(event.id), JSON.stringify(event), "EX", EVENT_TTL_S).lpush(EVENTS, event.id).ltrim(EVENTS, 0, EVENTS_LIMIT - 1).exec();
    this.logger.warn(`Defesa: ${DEFENSE_REASON_LABEL[reason]} de ${ip} (${req.method} ${event.path}): ${{ banned: "IP banido", watched: "só registrado (DEFENSE_MODE=watch)", suspected: "suspeita" }[action]}`);
    if (this.jev.enabled) void this.analyze(event, userAgent);
  }

  /** O Jev analisa o caso; um padrão já analisado reaproveita a conclusão sem chamar o Jev de novo. */
  private async analyze(event: StoredEvent, userAgent: string | null): Promise<void> {
    try {
      const [requests, failures, emails] = await Promise.all([
        this.redis.lrange(key.recent(event.ip), 0, -1),
        this.redis.get(key.auth(event.ip)),
        this.redis.scard(key.emails(event.ip)),
      ]);
      const failedLogins = Number(failures ?? 0);
      // Logins recusados entram na faixa: 12 e 14 tentativas são o mesmo padrão.
      const signature = sha256(JSON.stringify([event.reason, [...new Set(requests)].sort(), Math.floor(failedLogins / 10), Math.min(emails, 5)]));
      const cached = await this.redis.get(key.verdict(signature));
      let analysis: DefenseAnalysisDto;
      if (cached) {
        analysis = { ...(JSON.parse(cached) as Omit<DefenseAnalysisDto, "reused">), reused: true };
      } else {
        const result = await this.jev.analyze({ rule: DEFENSE_REASON_LABEL[event.reason], requests, failedLogins, distinctEmails: emails, userAgent });
        await this.redis.set(key.verdict(signature), JSON.stringify(result), "EX", VERDICT_TTL_S);
        analysis = { ...result, reused: false };
      }
      const current = (await this.event(event.id)) ?? event;
      let bannedUntil = current.bannedUntil;
      // Ataque confirmado: o banimento da regra (que ainda vale) passa a 7 dias.
      if (analysis.conclusion === "attack" && current.action === "banned" && (await this.redis.get(key.ban(event.ip))) === event.id) {
        await this.redis.set(key.ban(event.ip), event.id, "PX", CONFIRMED_BAN_MS);
        bannedUntil = new Date(Date.now() + CONFIRMED_BAN_MS).toISOString();
      }
      await this.save({ ...current, bannedUntil, analysis: { state: "done", ...analysis } });
    } catch (error) {
      this.logger.warn(`Defesa: o Jev não analisou o caso ${event.id}: ${String(error)}`);
      const current = await this.event(event.id).catch(() => null);
      if (current) await this.save({ ...current, analysis: { state: "failed" } }).catch(() => {});
    }
  }

  private async event(id: string): Promise<StoredEvent | null> {
    const raw = await this.redis.get(key.event(id));
    return raw ? (JSON.parse(raw) as StoredEvent) : null;
  }

  private async save(event: StoredEvent): Promise<DefenseEventDto> {
    await this.redis.set(key.event(event.id), JSON.stringify(event), "KEEPTTL");
    return { ...event, active: (await this.redis.get(key.ban(event.ip))) === event.id };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
