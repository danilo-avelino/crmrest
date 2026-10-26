import type { PageElement, PageSnapshot } from "@dishdesk/shared";
import type { Decision } from "./agent-guard.js";

/**
 * O caminho do iFood, sem a LLM: o modelo local erra a página do portal (abre menus, vai para o Financeiro, pede ao
 * parceiro para procurar). No portal: /apps → "Ativar integração por código" → o parceiro cola o código de vinculação do
 * Dish Desk nas caixinhas → Continuar; com o código de autorização na tela ("Integração autorizada"), volta ao Dish Desk,
 * o parceiro cola o código e a IA conecta. O que não se encaixa aqui fica com a LLM.
 */
export const IFOOD_PORTAL = "portal.ifood.com.br";
const APPS_URL = `https://${IFOOD_PORTAL}/apps`;
/** Os códigos do iFood (vinculação e autorização): quatro letras ou números, hífen, mais quatro. */
const CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g;
/** O texto do modal do iFood no Dish Desk, logo antes do código de vinculação (integrations-tab.tsx). */
export const LINK_CODE_HINT = "confira este código";

/**
 * Os códigos o parceiro cola, com o botão Copiar do painel (o `fill` do caminho vira o cartão "Sua vez" com o código): as
 * caixinhas do iFood são campo de código, que a IA não preenche, e no Dish Desk o parceiro cola o que o iFood devolveu.
 */
const PASTE_LINK_CODE_SAY =
  "O iFood pede que você mesmo coloque o código de ativação. Clique em Copiar aqui embaixo, depois na primeira caixinha do iFood, e cole (Ctrl+V). Em seguida clique em Continuar no iFood e em Pronto aqui, que eu continuo.";
const PASTE_AUTH_CODE_SAY =
  "O iFood autorizou e devolveu o código de autorização. Clique em Copiar aqui embaixo e cole no campo Código de autorização do Dish Desk (Ctrl+V). Depois clique em Pronto que eu conecto.";

/** O código de vinculação que o Dish Desk mostrou: o primeiro depois do texto do modal. */
export function linkCodeOf(text: string | null | undefined): string | null {
  const at = text?.indexOf(LINK_CODE_HINT) ?? -1;
  return at === -1 ? null : (text!.slice(at).match(CODE)?.[0] ?? null);
}

/**
 * O código de autorização que o portal mostrou (diferente do de vinculação): no campo do modal "Integração autorizada"
 * (os valores dos campos são as linhas do meio do que foi guardado da página; o texto, cortado antes do modal, é a
 * última) ou no texto, logo depois de "autorização". Outro código da página não serve.
 */
export function authCodeOf(portalSeen: string | null | undefined, linkCode: string | null): string | null {
  const values = portalSeen?.split("\n").slice(1, -1).join("\n");
  const inField = values?.match(CODE)?.find((item) => item !== linkCode);
  if (inField) return inField;
  for (const near of portalSeen?.matchAll(/autoriza[çc][ãa]o.{0,120}/gis) ?? []) {
    const code = near[0].match(CODE)?.find((item) => item !== linkCode);
    if (code) return code;
  }
  return null;
}

/** O que a sessão já fez com o código de vinculação atual (o de antes não conta: o iFood recusou ou venceu). */
export type IfoodState = {
  linkCode: string | null;
  authCode: string | null;
  /** O código já foi para o iFood (o cartão de colar apareceu ou a IA clicou em Continuar): não abre o modal de novo. */
  submitted: boolean;
  /** Houve um Conectar com este código: um erro na tela é dele, e um novo código recomeça. */
  connected: boolean;
};

type Rail = IfoodState & {
  page: PageSnapshot | undefined;
  panelHost: string;
  /** Os sites já abertos nesta sessão (o portal: volta com switch, sem login de novo). */
  opened: string[];
};

export function ifoodRail({ page, panelHost, linkCode, authCode, opened, submitted, connected }: Rail): Decision | null {
  if (!page) return null;
  const url = new URL(page.url);
  if (url.hostname === IFOOD_PORTAL) {
    if (authCode) return decision("switch", `O iFood gerou o código de autorização. Vou voltar ao Dish Desk para concluir.`, { value: panelHost });
    if (!url.pathname.startsWith("/apps")) return decision("navigate", "Vou abrir a página de integrações do Portal do Parceiro.", { value: APPS_URL });
    if (!linkCode) return null;
    const boxes = page.elements.filter((element) => element.role === "campo" && !element.disabled && !/buscar|pesquis|search/i.test(element.name));
    // O modal aberto: pelo texto ou pelos elementos dele (o texto da página longa é cortado antes do modal, que fica no fim).
    const modal = /ativar uma integra[çc][ãa]o|c[óo]digo de ativa[çc][ãa]o/i.test(page.text) || page.elements.some((element) => /^continuar$/i.test(element.name)) || boxes.length >= 4;
    if (modal) {
      // O Continuar só habilita com o código completo (as caixinhas são campo de código: a extensão não manda o valor delas).
      const next = button(page, /^continuar$/i);
      if (next) return decision("click", "Vou continuar a ativação.", { ref: next.ref });
      if (submitted) return null;
      return boxes.length ? decision("fill", PASTE_LINK_CODE_SAY, { ref: boxes[0]!.ref, value: linkCode }) : null;
    }
    const open = button(page, /ativar integra[çc][ãa]o por c[óo]digo/i);
    return open && !submitted ? decision("click", "Vou clicar em Ativar integração por código.", { ref: open.ref }) : null;
  }
  if (url.hostname !== panelHost || !page.text.includes(LINK_CODE_HINT)) return null;
  // O iFood recusou o código (errado ou vencido): um código de vinculação novo e a ativação de novo.
  const again = button(page, /gerar outro/i);
  if (connected && again && /n[ãa]o foi aceito|c[óo]digo de vincula[çc][ãa]o n[ãa]o [ée] v[áa]lido/i.test(page.text)) {
    return decision("click", "O iFood não aceitou o código. Vou gerar um novo código de vinculação e refazer a ativação.", { ref: again.ref });
  }
  const field = page.elements.find((element) => /c[óo]digo de autoriza[çc][ãa]o/i.test(element.name));
  if (!field) return null;
  if (authCode) {
    if (field.value !== authCode) return decision("fill", PASTE_AUTH_CODE_SAY, { ref: field.ref, value: authCode });
    const connect = button(page, /^conectar$/i);
    return connect ? decision("click", "Vou clicar em Conectar para concluir a integração do iFood.", { ref: connect.ref }) : null;
  }
  if (!linkCode) return null;
  const say = "Vou ao Portal do Parceiro do iFood ativar a integração com o código do Dish Desk.";
  return opened.includes(IFOOD_PORTAL) ? decision("switch", say, { value: IFOOD_PORTAL }) : decision("login", say, { value: APPS_URL });
}

function button(page: PageSnapshot, name: RegExp): PageElement | undefined {
  return page.elements.find((element) => element.role !== "campo" && !element.disabled && name.test(element.name));
}

function decision(action: Decision["action"], say: string, extra: { ref?: number; value?: string }): Decision {
  return { say, action, ref: extra.ref ?? 0, value: extra.value ?? "", irreversible: false, reason: "" };
}
