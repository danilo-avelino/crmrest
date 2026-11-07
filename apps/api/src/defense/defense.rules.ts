import { BlockList, isIP } from "node:net";
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

/** Rede interna e o próprio computador: o servidor do painel, a rede privada da Railway, desenvolvimento e testes. */
const INTERNAL_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
];

/**
 * A Fastly, CDN na frente da Railway (lista publicada em https://api.fastly.com/public-ip-list, conferida em
 * 07/11/2026). Às vezes a borda da Railway grava no X-Real-IP o IP da Fastly, e não o do visitante: um IP desses é de
 * muita gente ao mesmo tempo, e bani-lo trancaria clientes de verdade.
 */
const FASTLY_RANGES = [
  "23.235.32.0/20",
  "43.249.72.0/22",
  "90.98.0.0/17",
  "90.98.128.0/18",
  "103.244.50.0/24",
  "103.245.222.0/23",
  "103.245.224.0/24",
  "104.156.80.0/20",
  "140.248.64.0/18",
  "140.248.128.0/17",
  "146.75.0.0/17",
  "151.101.0.0/16",
  "157.52.64.0/18",
  "167.82.0.0/17",
  "167.82.128.0/20",
  "167.82.160.0/20",
  "167.82.224.0/20",
  "172.111.64.0/18",
  "185.31.16.0/22",
  "199.27.72.0/21",
  "199.232.0.0/16",
  "2a04:4e40::/32",
  "2a04:4e42::/31",
  "2a04:4e44::/32",
];

/**
 * IPs que a defesa nunca bane: a rede interna, a Fastly e os da DEFENSE_ALLOW_IPS (IPs ou faixas, separados por
 * vírgula, como o do escritório). Uma entrada inválida derruba a API na subida, para o erro não passar despercebido.
 */
export function neverBanList(allow = ""): BlockList {
  const list = new BlockList();
  const extra = allow.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of [...INTERNAL_RANGES, ...FASTLY_RANGES, ...extra]) {
    const [address = "", prefix] = entry.split("/");
    const type = isIP(address) === 6 ? "ipv6" : "ipv4";
    if (!isIP(address) || (prefix !== undefined && !/^\d{1,3}$/.test(prefix))) {
      throw new Error(`DEFENSE_ALLOW_IPS: "${entry}" não é um IP nem uma faixa (ex.: 200.1.2.3 ou 200.1.2.0/24).`);
    }
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  return list;
}

/**
 * IP de quem fez o pedido. Na Railway, a borda grava o IP do visitante no X-Real-IP, e o Next repassa os cabeçalhos
 * ao chamar a API. Sem ele, vale o endereço da conexão (desenvolvimento e testes). IPs da lista de nunca banir ou
 * inválidos devolvem null: a defesa não age sobre eles.
 */
export function clientIp(req: Request, neverBan: BlockList): string | null {
  const header = req.headers["x-real-ip"];
  const raw = (Array.isArray(header) ? header[0] : header)?.trim() || req.socket.remoteAddress || "";
  const ip = (raw.startsWith("::ffff:") ? raw.slice(7) : raw).toLowerCase();
  const type = isIP(ip);
  if (!type || neverBan.check(ip, type === 6 ? "ipv6" : "ipv4")) return null;
  return ip;
}
