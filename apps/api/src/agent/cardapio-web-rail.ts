import type { PageElement, PageSnapshot } from "@dishdesk/shared";
import type { Decision } from "./agent-guard.js";

/**
 * O caminho no Portal do Cardápio Web até a gaveta "API de integração", sem a LLM: o modelo local fica clicando em
 * Configurações sem sair do lugar. Configurações → Integrações → API de integração; com a gaveta aberta (código da loja e
 * token), volta ao Dish Desk, onde a LLM preenche o modal com o que leu (PÁGINA ANTERIOR). Nunca clica em "Gerar um novo token".
 */
export const CARDAPIO_WEB_HOST = "cardapioweb.com";

export function cardapioWebRail({ page, panelHost }: { page: PageSnapshot | undefined; panelHost: string }): Decision | null {
  if (!page) return null;
  const url = new URL(page.url);
  if (url.hostname !== CARDAPIO_WEB_HOST && !url.hostname.endsWith(`.${CARDAPIO_WEB_HOST}`)) return null;
  // A gaveta aberta: o código da loja e o token já estão na página.
  if (page.elements.some((element) => /copiar token/i.test(element.name))) {
    return decision("switch", "Já tenho o código da loja e o token. Vou voltar ao Dish Desk para preencher a integração.", { value: panelHost });
  }
  const api = find(page, /api de integra[çc][ãa]o/i);
  if (api) return decision("click", "Vou abrir a API de integração.", { ref: api.ref });
  if (url.pathname.startsWith("/configuracoes")) {
    const integrations = find(page, /integra[çc][õo]es$/i);
    return integrations ? decision("click", "Vou abrir Integrações nas configurações da loja.", { ref: integrations.ref }) : null;
  }
  const settings = find(page, /configura[çc][õo]es$/i);
  return settings ? decision("click", "Vou abrir as Configurações da loja.", { ref: settings.ref }) : null;
}

function find(page: PageSnapshot, name: RegExp): PageElement | undefined {
  return page.elements.find((element) => element.role !== "campo" && !element.disabled && name.test(element.name.trim()));
}

function decision(action: Decision["action"], say: string, extra: { ref?: number; value?: string }): Decision {
  return { say, action, ref: extra.ref ?? 0, value: extra.value ?? "", irreversible: false, reason: "" };
}
