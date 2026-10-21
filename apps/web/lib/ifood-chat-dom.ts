import type { IfoodChatSync } from "@dishdesk/shared";

// Leitura do widget do iFood a partir do HTML que a extensão devolve (apps/extension), com a posição de cada elemento em
// data-dd-rect. O widget não tem ids nem nomes estáveis nas mensagens (as classes mudam a cada versão): a leitura se
// apoia na estrutura, nos poucos ids fixos e nos ícones. Se o iFood mudar o HTML, é este arquivo que muda.

/** Botão flutuante que abre e fecha o widget. */
export const LAUNCHER = "#embeddables-main-button";
/** Aba Chat do widget aberto. */
export const CHAT_TAB = "#CHAT";
/** Conversas da aba Chat ("Pedidos abertos" e "Pedidos concluídos"): o botão com número, prévia, loja e hora. */
export const CHAT_ITEM = '.chats-tabs [role="tabpanel"] button:has(span + span + span)';

const HEADER = /^#(\d+)\s*-\s*(.*)$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const FIELD = 'textarea, input:not([type="hidden"]), [contenteditable="true"]';
/** Diferença mínima entre as margens do balão para dizer de que lado ele está. */
const SIDE_GAP_PX = 6;

/** Mensagem da conversa aberta. `direction` null = o balão não mostra de que lado está (sem posições, ou centralizado). */
export type WidgetBubble = { direction: IfoodChatSync["messages"][number]["direction"] | null; text: string; time: string };

/** Conversa na lista da aba Chat. `index` é a posição entre os CHAT_ITEM, para o clique. */
export type WidgetChat = { index: number; open: boolean; orderCode: string; customer: string; preview: string; stamp: string };

/** Conversa aberta (a gaveta ao lado do widget). Os seletores valem no widget, para a extensão clicar e digitar. */
export type WidgetDrawer = {
  orderCode: string;
  bubbles: WidgetBubble[];
  close: string;
  /** Campo da resposta; null = o iFood encerrou a conversa. */
  input: string | null;
  send: string | null;
};

export type WidgetState = {
  /** O widget está aberto (dá para ver as abas). */
  panel: boolean;
  chatTab: boolean;
  /**
   * A loja ainda não autorizou o widget neste computador, e só ela resolve: `unauthorized` = o widget mostra o convite
   * para ir ao Portal do Parceiro; `authorizing` = a autorização está sendo dada lá.
   */
  authorization: "unauthorized" | "authorizing" | null;
  chats: WidgetChat[];
  drawers: WidgetDrawer[];
};

export function readWidget(html: string): WidgetState {
  const document = new DOMParser().parseFromString(html, "text/html");
  const panel = document.querySelector(CHAT_TAB) !== null;
  const chatTab = document.querySelector(".chats-tabs") !== null;
  const tabs = [...document.querySelectorAll('.chats-tabs [role="tabpanel"]')];
  const chats = [...document.querySelectorAll(CHAT_ITEM)].flatMap((button, index): WidgetChat[] => {
    const [header, preview, , stamp] = [...button.querySelectorAll("span")].map(text);
    const match = HEADER.exec(header ?? "");
    if (!match) return [];
    // A primeira aba é "Pedidos abertos"; as duas ficam no HTML ao mesmo tempo.
    const open = tabs.findIndex((tab) => tab.contains(button)) === 0;
    return [{ index, open, orderCode: match[1]!, customer: match[2]!, preview: preview ?? "", stamp: stamp ?? "" }];
  });
  const drawers = [...document.querySelectorAll("[data-column-index] > [data-hit-region]")].flatMap((region) => {
    const drawer = readDrawer(region);
    return drawer ? [drawer] : [];
  });
  const words = document.body.textContent ?? "";
  const authorization = panel ? null : /autorização em andamento/i.test(words) ? "authorizing" : /portal do parceiro/i.test(words) ? "unauthorized" : null;
  return { panel, chatTab, authorization, chats, drawers };
}

function readDrawer(region: Element): WidgetDrawer | null {
  if (region.querySelector(CHAT_TAB)) return null; // é o próprio widget, não uma conversa
  const header = [...region.querySelectorAll("span")].map(text).find((value) => HEADER.test(value));
  const column = region.parentElement?.getAttribute("data-column-index");
  if (!header || !column) return null;
  const scope = `[data-column-index="${column}"] > [data-hit-region]`;
  const field = region.querySelector(FIELD);
  const sendIcon = region.querySelector('button [class*="ifdl-icon-send"]');
  return {
    orderCode: HEADER.exec(header)![1]!,
    bubbles: readBubbles(region),
    close: `${scope} button:has(.ifdl-icon-close)`,
    input: field ? `${scope} ${field.matches("textarea") ? "textarea" : field.matches("input") ? 'input:not([type="hidden"])' : '[contenteditable="true"]'}` : null,
    send: field && sendIcon ? `${scope} button:has([class*="ifdl-icon-send"])` : null,
  };
}

/** Cada mensagem é um balão com o texto e a hora. O lado do balão diz quem enviou: à direita, a loja; à esquerda, o cliente. */
function readBubbles(region: Element): WidgetBubble[] {
  const frame = rect(region);
  const bubbles: WidgetBubble[] = [];
  for (const clock of [...region.querySelectorAll("span")].filter((span) => CLOCK.test(text(span)))) {
    // O balão é o menor elemento que tem a hora e mais algum texto.
    let bubble = clock.parentElement;
    while (bubble && bubble !== region && text(bubble) === text(clock)) bubble = bubble.parentElement;
    if (!bubble || bubble === region) continue;
    // A hora fecha o balão; o resto é a mensagem, com as quebras de linha como estão.
    const whole = (bubble.textContent ?? "").trim();
    const body = whole.endsWith(text(clock)) ? whole.slice(0, -text(clock).length).trim() : whole;
    const box = rect(bubble);
    if (!body || fromIfood(bubble, body)) continue;
    const left = frame && box ? box.x - frame.x : 0;
    const right = frame && box ? frame.x + frame.width - (box.x + box.width) : 0;
    const direction = Math.abs(left - right) < SIDE_GAP_PX ? null : left > right ? "OUTBOUND" : "INBOUND";
    bubbles.push({ direction, text: body, time: text(clock) });
  }
  return bubbles;
}

/**
 * Aviso do próprio iFood para a loja no meio da conversa ("Sua loja demora pra responder..."): o balão abre com o rótulo
 * "iFood" num texto à parte, do lado do cliente. Não é mensagem dele e fica fora da cópia (senão chamaria a equipe).
 */
function fromIfood(bubble: Element, body: string): boolean {
  const walker = bubble.ownerDocument.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
  let first = "";
  while (!first && walker.nextNode()) first = (walker.currentNode.textContent ?? "").trim();
  return first === "iFood" && body !== "iFood";
}

function text(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function rect(element: Element): { x: number; width: number } | null {
  const [x, , width] = (element.getAttribute("data-dd-rect") ?? "").split(",").map(Number);
  return x === undefined || width === undefined || Number.isNaN(x) || !width ? null : { x, width };
}
