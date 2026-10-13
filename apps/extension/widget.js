// Ponte entre o painel do Dish Desk e o widget do iFood. Roda dentro do iframe do widget (embeddables.ifood.com.br),
// que o painel não consegue ler por ser de outro domínio. O painel pede por postMessage e a ponte responde.
// A leitura do chat (seletores, campos) fica no painel: o iFood muda o HTML do widget sem aviso, e o painel é
// atualizado por deploy, sem reinstalar a extensão.

const PANELS = ["https://www.dishdesk.com.br", "http://localhost:3000"];
const TAG = "ifood-bridge";

/** HTML dos elementos do seletor; sem seletor, a página inteira do widget. */
function html(selector) {
  if (!selector) return [document.documentElement.outerHTML];
  return [...document.querySelectorAll(selector)].map((element) => element.outerHTML);
}

// Só dentro do painel do Dish Desk: o mesmo widget aparece em outros sistemas, e neles a ponte fica parada.
if (window.top !== window && PANELS.includes(location.ancestorOrigins[0])) {
  window.addEventListener("message", (event) => {
    const request = event.data;
    if (!PANELS.includes(event.origin) || request?.dishdesk !== TAG || !request.op) return;
    const reply = (body) => event.source.postMessage({ dishdesk: TAG, id: request.id, ...body }, event.origin);
    try {
      if (request.op === "ping") reply({ ok: true, version: chrome.runtime.getManifest().version });
      else if (request.op === "html") reply({ ok: true, html: html(request.selector) });
      else reply({ ok: false, error: `Operação desconhecida: ${request.op}` });
    } catch (error) {
      reply({ ok: false, error: String(error) });
    }
  });
}
