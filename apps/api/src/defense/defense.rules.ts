import { isIP } from "node:net";
import type { DefenseReason } from "@dishdesk/shared";
import type { Request } from "express";

/** Banimento automático por regra, e por quanto tempo. */
export const BAN_MS: Record<DefenseReason, number> = {
  sensitive_probe: 24 * 60 * 60_000,
  endpoint_enumeration: 24 * 60 * 60_000,
  auth_abuse: 60 * 60_000,
};
/** Quando o Jev confirma o ataque, o banimento passa a valer por isto (contado da confirmação). */
export const CONFIRMED_BAN_MS = 7 * 24 * 60 * 60_000;
/** Banimento à mão, pelo painel da plataforma. */
export const MANUAL_BAN_MS = 7 * 24 * 60 * 60_000;

/** Rotas diferentes (já sem os ids) que deram 404 na janela, até banir: varredura de endpoints. */
export const NOT_FOUND_LIMIT = 20;
export const NOT_FOUND_WINDOW_MS = 10 * 60_000;
/** Logins recusados na janela: ao chegar na suspeita, o Jev analisa; no limite, o IP é banido. */
export const AUTH_SUSPECT = 10;
export const AUTH_LIMIT = 30;
export const AUTH_WINDOW_MS = 15 * 60_000;

/**
 * Caminhos que só um robô atrás de segredos ou de painéis de outros sistemas pede: a API não tem nada disso. Um pedido
 * já bane (com prazo), sem esperar a análise.
 */
const SENSITIVE_PATHS = [
  /(^|\/)\.(env|git|svn|hg|aws|ssh|docker|npmrc|htaccess|htpasswd|ds_store)(\/|\.|$)/i,
  /(^|\/)actuator(\/|$)/i,
  /(^|\/)(heapdump|server-status|phpinfo|phpmyadmin|cgi-bin)(\/|\.|$)/i,
  /(^|\/)(wp-admin|wp-login|wp-content|wp-includes|xmlrpc)(\/|\.|$)/i,
  /(^|\/)vendor\/phpunit(\/|$)/i,
  /\.(php|asp|aspx|jsp|cgi|sql|bak|old|swp)$/i,
];

export function isSensitiveProbe(path: string): boolean {
  return SENSITIVE_PATHS.some((pattern) => pattern.test(path));
}

/** Logins recusados contam como tentativa: senha errada (401) e o limite por IP estourado (429). */
export function isFailedLogin(method: string, path: string, status: number): boolean {
  return method === "POST" && path === "/api/auth/login" && (status === 401 || status === 429);
}

/** A rota sem os ids: o 404 de um contato apagado, aberto várias vezes, conta como uma rota só. */
export function routePattern(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/\d+(?=\/|$)/g, "/:n")
    .slice(0, 200);
}

/**
 * IP de quem fez o pedido. Na Railway, a borda grava o IP do visitante no X-Real-IP, e o Next repassa os cabeçalhos
 * ao chamar a API. Sem ele, vale o endereço da conexão (desenvolvimento e testes). Endereços da rede interna, do
 * próprio computador ou inválidos devolvem null: a defesa nunca bane o servidor do painel nem a rede da Railway.
 */
export function clientIp(req: Request): string | null {
  const header = req.headers["x-real-ip"];
  const raw = (Array.isArray(header) ? header[0] : header)?.trim() || req.socket.remoteAddress || "";
  const ip = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  if (!isIP(ip) || isInternal(ip)) return null;
  return ip.toLowerCase();
}

function isInternal(ip: string): boolean {
  if (isIP(ip) === 6) return ip === "::1" || ip === "::" || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip);
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
