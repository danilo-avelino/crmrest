// Ponte entre o painel do Dish Desk e o widget do iFood. Roda dentro do iframe do widget (embeddables.ifood.com.br),
// que o painel não consegue ler por ser de outro domínio. O painel pede por postMessage e a ponte responde.
// A leitura do chat (seletores, campos) fica no painel: o iFood muda o HTML do widget sem aviso, e o painel é
// atualizado por deploy, sem reinstalar a extensão.

const PANELS = ["https://www.dishdesk.com.br", "http://localhost:3000"];
const TAG = "ifood-bridge";

/** Elemento número `index` do seletor; sem ele, a operação falha (o painel decide o que fazer). */
function find(selector, index = 0) {
  const element = document.querySelectorAll(selector)[index];
  if (!element) throw new Error(`Elemento não encontrado: ${selector} [${index}]`);
  return element;
}

/** HTML dos elementos do seletor; sem seletor, a página inteira do widget. */
function html(selector) {
  if (!selector) return [document.documentElement.outerHTML];
  return [...document.querySelectorAll(selector)].map((element) => element.outerHTML);
}

/** Escreve num campo como se fosse digitado: o React só enxerga o valor posto pelo setter nativo, seguido do evento. */
function fill(selector, index, text) {
  const element = find(selector, index);
  if (element.isContentEditable) element.textContent = text;
  else Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value").set.call(element, text);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function press(selector, index, key) {
  const element = find(selector, index);
  for (const type of ["keydown", "keypress", "keyup"]) element.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true }));
}

const OPERATIONS = {
  ping: () => ({ version: chrome.runtime.getManifest().version }),
  html: ({ selector }) => ({ html: html(selector) }),
  click: ({ selector, index }) => void find(selector, index).click(),
  fill: ({ selector, index, text }) => fill(selector, index, String(text ?? "")),
  key: ({ selector, index, key }) => press(selector, index, key),
};

// Só dentro do painel do Dish Desk: o mesmo widget aparece em outros sistemas, e neles a ponte fica parada.
if (window.top !== window && PANELS.includes(location.ancestorOrigins[0])) {
  window.addEventListener("message", (event) => {
    const request = event.data;
    if (!PANELS.includes(event.origin) || request?.dishdesk !== TAG || !request.op) return;
    const reply = (body) => event.source.postMessage({ dishdesk: TAG, id: request.id, ...body }, event.origin);
    try {
      if (!Object.hasOwn(OPERATIONS, request.op)) throw new Error(`Operação desconhecida: ${request.op}`);
      reply({ ok: true, ...OPERATIONS[request.op](request) });
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
