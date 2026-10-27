import type { PageElement, PageSnapshot } from "@dishdesk/shared";
import type { Decision } from "./agent-guard.js";

/**
 * O caminho no Portal do Cardápio Web até a gaveta "API de integração", sem a LLM: o modelo local fica clicando em
 * Configurações sem sair do lugar. Configurações → Integrações → API de integração; com a gaveta aberta (código da loja e
 * token), volta ao Dish Desk e preenche o modal do Cardápio Web com os dois. Nunca clica em "Gerar um novo token".
 */
export const CARDAPIO_WEB_HOST = "cardapioweb.com";
/**
 * O código da loja e o token no texto da gaveta (a tela corta o token com reticências; o texto o traz inteiro). A gaveta
 * fica no fim do texto da página, depois do corte do que é guardado: o agente guarda este trecho antes (seenOf).
 */
export const CARDAPIO_WEB_CREDENTIALS = /c[óo]digo da loja\s*(\d+)\s*copiar\s*(\S{20,})\s*copiar token/i;

export type CardapioWebCredentials = { storeId: string; apiKey: string };

export function credentialsOf(text: string | null | undefined): CardapioWebCredentials | null {
  const match = text?.match(CARDAPIO_WEB_CREDENTIALS);
  return match ? { storeId: match[1]!, apiKey: match[2]! } : null;
}

type Rail = { page: PageSnapshot | undefined; panelHost: string; credentials: CardapioWebCredentials | null };

export function cardapioWebRail({ page, panelHost, credentials }: Rail): Decision | null {
  if (!page) return null;
  const url = new URL(page.url);
  if (url.hostname === panelHost) return credentials ? connect(page, credentials) : null;
  if (url.hostname !== CARDAPIO_WEB_HOST && !url.hostname.endsWith(`.${CARDAPIO_WEB_HOST}`)) return null;
  // A gaveta aberta: o código da loja e o token já estão na página.
  if (page.elements.some((element) => /copiar token/i.test(element.name))) {
    return decision("switch", "Já tenho o código da loja e o token. Vou voltar ao Dish Desk para preencher a integração.", { value: panelHost });
  }
  const api = find(page, /api de integra[çc][ãa]o/i);
  if (api) return decision("click", "Vou abrir a API de integração.", { ref: api.ref });
  // Pelo menu, não pelo endereço: o das Configurações não é um caminho conhecido.
  const integrations = find(page, /integra[çc][õo]es$/i);
  if (integrations) return decision("click", "Vou abrir Integrações nas configurações da loja.", { ref: integrations.ref });
  const settings = find(page, /configura[çc][õo]es$/i);
  return settings ? decision("click", "Vou abrir as Configurações da loja.", { ref: settings.ref }) : null;
}

/** O modal "Cardápio Web · Nova integração" do Dish Desk aberto: o código da loja, o token e o Conectar do modal. */
function connect(page: PageSnapshot, { storeId, apiKey }: CardapioWebCredentials): Decision | null {
  const field = (name: RegExp) => page.elements.find((element) => element.role === "campo" && !element.disabled && name.test(element.name.trim()));
  const store = field(/^c[óo]digo da loja$/i);
  const key = field(/^chave de api$/i);
  if (!store || !key || !/card[áa]pio web/i.test(page.text)) return null;
  if (store.value !== storeId) return decision("fill", "Vou preencher o código da loja.", { ref: store.ref, value: storeId });
  if (key.value !== apiKey) return decision("fill", "Vou colar o token da API do Cardápio Web.", { ref: key.ref, value: apiKey });
  // O "Conectar" do modal, não os das linhas da lista atrás dele: o modal aparece depois, com o número mais alto.
  const submit = page.elements
    .filter((element) => element.role !== "campo" && !element.disabled && /^conectar$/i.test(element.name.trim()))
    .reduce<PageElement | undefined>((newest, element) => (!newest || element.ref > newest.ref ? element : newest), undefined);
  return submit ? decision("click", "Vou clicar em Conectar para concluir a integração do Cardápio Web.", { ref: submit.ref }) : null;
}

function find(page: PageSnapshot, name: RegExp): PageElement | undefined {
  return page.elements.find((element) => element.role !== "campo" && !element.disabled && name.test(element.name.trim()));
}

function decision(action: Decision["action"], say: string, extra: { ref?: number; value?: string }): Decision {
  return { say, action, ref: extra.ref ?? 0, value: extra.value ?? "", irreversible: false, reason: "" };
}
