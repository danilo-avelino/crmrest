import { type AgentAction, type AgentPageAction, hostAllowed, type PageElement, type PageSnapshot, type SensitiveField } from "@dishdesk/shared";

/** O que a LLM decidiu (schema AgentDecision), antes das travas. */
export type Decision = {
  say: string;
  action: "click" | "fill" | "select" | "navigate" | "reply" | "done" | "handoff";
  ref: number;
  value: string;
  irreversible: boolean;
  reason: string;
};

/** Pelo nome do campo, além do que a extensão marcou: senha, código de verificação ou cartão. */
const SENSITIVE: [SensitiveField, RegExp][] = [
  ["password", /senha|password|passcode/i],
  ["code", /verifica[çc][ãa]o|\botp\b|2fa|\bsms\b|autenticador|one.?time|c[óo]digo de seguran[çc]a|security code/i],
  ["card", /cart[ãa]o|\bcard\b|\bcvv\b|\bcvc\b|validade do cart/i],
];

/** Ações que não dá para desfazer ou que falam em nome do restaurante: só com a confirmação do parceiro. */
const IRREVERSIBLE =
  /aceit|concord|autoriz|\benviar\b|\bsubmit\b|publicar|\bpagar\b|pagamento|assinar|contratar|finalizar|excluir|apagar|remover|deletar|desconectar|desvincular|encerrar|cancelar (a |o )?(conta|assinatura|plano|loja)/i;

export function sensitiveOf(element: PageElement): SensitiveField | null {
  if (element.sensitive) return element.sensitive;
  return SENSITIVE.find(([, pattern]) => pattern.test(element.name))?.[0] ?? null;
}

const FIELD_SAY: Record<SensitiveField, string> = {
  password: "Essa parte é com você: digite a sua senha na página e clique em Pronto quando terminar.",
  code: "Essa parte é com você: digite o código de verificação na página e clique em Pronto quando terminar.",
  card: "Essa parte é com você: preencha os dados do cartão na página e clique em Pronto quando terminar.",
};

export type Guarded = { next: AgentAction } | { invalid: string };

/**
 * As regras obrigatórias do E31, no código (a LLM pode errar): a IA só age nos sites permitidos, nunca preenche senha,
 * código nem cartão e pede confirmação antes do que não dá para desfazer. `invalid`: a ação não serve (elemento que não
 * existe, endereço errado); a LLM decide de novo.
 */
export function guard(decision: Decision, page: PageSnapshot | undefined, allowed: readonly string[], known = ""): Guarded {
  const say = decision.say;
  if (decision.action === "reply") return { next: { type: "reply", say } };
  if (decision.action === "handoff") return { next: { type: "handoff", say, reason: decision.reason.trim() || "Pedido do parceiro" } };
  if (decision.action === "done") return { next: { type: "done", say } };

  if (decision.action === "navigate") {
    let url: URL;
    try {
      url = new URL(decision.value);
    } catch {
      return { invalid: `"${decision.value}" não é um endereço.` };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { invalid: `"${decision.value}" não é um endereço.` };
    if (!hostAllowed(url.hostname, allowed)) return { next: permission(url.hostname) };
    const action: AgentPageAction = { type: "navigate", url: url.toString() };
    return { next: decision.irreversible ? { type: "confirm", say, action } : { type: "act", say, action } };
  }

  if (!page) return { invalid: "Não há página aberta para agir." };
  const host = new URL(page.url).hostname;
  if (!hostAllowed(host, allowed)) return { next: permission(host) };
  const element = page.elements.find((candidate) => candidate.ref === decision.ref);
  if (!element) return { invalid: `O elemento [${decision.ref}] não está na PÁGINA.` };
  if (element.disabled) return { invalid: `O elemento [${decision.ref}] está desabilitado.` };

  const label = element.name || element.role;
  if (decision.action === "fill" || decision.action === "select") {
    const field = sensitiveOf(element);
    if (field) return { next: { type: "your_turn", say: FIELD_SAY[field], ref: element.ref, field } };
  }
  // A IA não inventa o que preencher (ex.: o usuário do Instagram): só o que o parceiro disse ou o que apareceu nas páginas.
  if (decision.action === "fill" && !normalize(known).includes(normalize(decision.value))) {
    return { invalid: `"${decision.value}" não foi dito pelo parceiro nem aparece nas páginas: pergunte a ele (reply).` };
  }
  const action: AgentPageAction =
    decision.action === "click" ? { type: "click", ref: element.ref, label } : { type: decision.action, ref: element.ref, label, value: decision.value };
  const confirm = decision.irreversible || (decision.action === "click" && IRREVERSIBLE.test(label));
  return { next: confirm ? { type: "confirm", say, action } : { type: "act", say, action } };
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

function permission(host: string): AgentAction {
  return { type: "permission", host, say: `Para continuar, preciso agir em ${host}, que não está entre os sites da implantação. Posso?` };
}
