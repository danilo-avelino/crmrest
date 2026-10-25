import { type AgentAction, type AgentPageAction, hostAllowed, type PageElement, type PageSnapshot, type SensitiveField } from "@dishdesk/shared";

/** O que a LLM decidiu (schema AgentDecision), antes das travas. */
export type Decision = {
  say: string;
  action: "click" | "fill" | "select" | "navigate" | "login" | "switch" | "reply" | "done" | "handoff";
  ref: number;
  value: string;
  irreversible: boolean;
  reason: string;
};

/** Pelo nome do campo, além do que a extensão marcou: senha, código de verificação ou cartão. */
const SENSITIVE: [SensitiveField, RegExp][] = [
  ["password", /senha|password|passcode/i],
  ["code", /verifica[çc][ãa]o|\botp\b|2fa|\bsms\b|autenticador|one.?time|c[óo]digo de seguran[çc]a|security code/i],
  // "card" sozinho, não "cardápio": o \b do JavaScript trata a letra acentuada como fim de palavra.
  ["card", /cart[ãa]o|\bcard(?!\p{L})|\bcvv\b|\bcvc\b|validade do cart/iu],
];

/** Ações que não dá para desfazer ou que falam em nome do restaurante: só com a confirmação do parceiro. */
const IRREVERSIBLE =
  /aceit|concord|autoriz|\benviar\b|\bsubmit\b|publicar|\bpagar\b|pagamento|assinar|contratar|finalizar|excluir|apagar|remover|deletar|desconectar|desvincular|encerrar|novo token|regenerar|cancelar (a |o )?(conta|assinatura|plano|loja)/i;

/** O parceiro pediu a implantação: conectar, salvar e criar fazem parte dela e não pedem confirmação, mesmo que a LLM marque irreversible. */
const ROUTINE = /^(conectar|salvar|criar|gerar|continuar|avan[çc]ar|pr[óo]ximo)\b/i;

export function sensitiveOf(element: PageElement): SensitiveField | null {
  if (element.sensitive) return element.sensitive;
  return SENSITIVE.find(([, pattern]) => pattern.test(element.name))?.[0] ?? null;
}

/** A IA pedindo ao parceiro o que ela mesma faz na página (ir a uma tela, clicar, copiar); só o que é no celular fica com ele. */
const ASKS_PARTNER_TO_ACT = /\b(v[áa] (em|para|até)|clique|copie|cole|acesse|procure|navegue)\b/i;
const ON_PHONE = /celular|\bqr\b|aplicativo|\bapp\b|aparelho/i;

const FIELD_SAY:Record<SensitiveField, string> = {
  password: "Essa parte é com você: digite a sua senha na página e clique em Login feito quando terminar.",
  code: "Essa parte é com você: digite o código de verificação na página e clique em Login feito quando terminar.",
  card: "Essa parte é com você: preencha os dados do cartão na página e clique em Login feito quando terminar.",
};

export type Guarded = { next: AgentAction } | { invalid: string };

/**
 * As regras obrigatórias do E31, no código (a LLM pode errar): a IA só age nos sites permitidos, nunca preenche senha,
 * código nem cartão e pede confirmação antes do que não dá para desfazer. `invalid`: a ação não serve (elemento que não
 * existe, endereço errado); a LLM decide de novo.
 */
export function guard(decision: Decision, page: PageSnapshot | undefined, allowed: readonly string[], known = ""): Guarded {
  const say = decision.say;
  if (decision.action === "reply") {
    if (ASKS_PARTNER_TO_ACT.test(say) && !ON_PHONE.test(say)) {
      return { invalid: "Não peça ao parceiro para ir a uma tela, clicar ou copiar: faça você mesma a ação na PÁGINA (navigate, click, fill) e diga em say o que você vai fazer." };
    }
    return { next: { type: "reply", say } };
  }
  if (decision.action === "handoff") return { next: { type: "handoff", say, reason: decision.reason.trim() || "Pedido do parceiro" } };
  if (decision.action === "done") return { next: { type: "done", say } };

  if (decision.action === "login") {
    const url = parseUrl(decision.value);
    if (!url) return { invalid: `"${decision.value}" não é um endereço.` };
    if (!hostAllowed(url.hostname, allowed)) return { next: permission(url.hostname) };
    // No Cardápio Web, a conta pode ter várias lojas: o parceiro escolhe qual integrar antes de avisar.
    const store = hostAllowed(url.hostname, ["cardapioweb.com"]) ? " Depois, escolha a loja que você quer integrar." : "";
    const say = `Abri ${url.hostname} em uma nova aba. Digite o seu usuário e a senha e entre.${store} Quando terminar, clique em Login feito e eu continuo daí.`;
    return { next: { type: "login", say, url: url.toString() } };
  }

  if (decision.action === "switch") {
    const host = (parseUrl(decision.value)?.hostname ?? decision.value.trim()).toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(host)) return { invalid: `"${decision.value}" não é um site.` };
    if (!hostAllowed(host, allowed)) return { next: permission(host) };
    return { next: { type: "act", say, action: { type: "switch", host } } };
  }

  if (decision.action === "navigate") {
    let url: URL;
    try {
      url = new URL(decision.value);
    } catch {
      return { invalid: `"${decision.value}" não é um endereço.` };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { invalid: `"${decision.value}" não é um endereço.` };
    if (!hostAllowed(url.hostname, allowed)) return { next: permission(url.hostname) };
    // Outro site abre numa aba nova: a aba atual (o Dish Desk, quase sempre) fica aberta para a IA voltar com switch.
    const current = page ? new URL(page.url).hostname : null;
    const action: AgentPageAction = { type: "navigate", url: url.toString(), ...(current && current !== url.hostname && { newTab: true }) };
    return { next: { type: "act", say, action } };
  }

  if (!page) return { invalid: "Não há página aberta para agir." };
  const host = new URL(page.url).hostname;
  if (!hostAllowed(host, allowed)) return { next: permission(host) };
  const element = page.elements.find((candidate) => candidate.ref === decision.ref);
  if (!element) {
    const exist = page.elements.slice(0, 12).map((item) => `[${item.ref}] ${item.name || item.role}`).join(", ");
    return {
      invalid: `O elemento [${decision.ref}] não está na PÁGINA (a aba atual é ${host}). Os que existem: ${exist || "nenhum"}. Para agir em outro site (ex.: colar um código num campo do Dish Desk), primeiro volte a ele com switch (value = o site); senão, navigate ou reply.`,
    };
  }
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
  // Só um clique não dá para desfazer: preencher e escolher mudam o que está na tela, não o que o restaurante já fez.
  const confirm = decision.action === "click" && (IRREVERSIBLE.test(label) || (decision.irreversible && !ROUTINE.test(label)));
  return { next: confirm ? { type: "confirm", say, action } : { type: "act", say, action } };
}

function parseUrl(text: string): URL | null {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

function permission(host: string): AgentAction {
  return { type: "permission", host, say: `Para continuar, preciso agir em ${host}, que não está entre os sites da implantação. Posso?` };
}
