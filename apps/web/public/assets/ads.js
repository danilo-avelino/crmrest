// Remarketing do site institucional: Pixel da Meta e tag do Google (GA4 + Google Ads). Só carrega com "Aceitar" no aviso
// (LGPD). Preencher os IDs abaixo; sem nenhum ID, nada carrega e o aviso não aparece.
(function () {
  var META_PIXEL_ID = ""; // ex.: "1234567890123456"
  var GOOGLE_TAG_IDS = []; // ex.: ["G-XXXXXXXXXX", "AW-XXXXXXXXX"]
  // Chave própria: a escolha do site não vale para o Pixel do cardápio de cada restaurante (dd-consent).
  var KEY = "dd-site-consent";
  if (!META_PIXEL_ID && !GOOGLE_TAG_IDS.length) return;

  function read() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY));
      return v && typeof v.ads === "boolean" ? v.ads : null;
    } catch (e) {
      return null;
    }
  }

  function save(granted) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ads: granted, at: Date.now() }));
    } catch (e) {
      // Sem armazenamento: a escolha vale só nesta página.
    }
  }

  // Trecho oficial do Pixel: a fila (queue) guarda os eventos até o fbevents.js carregar.
  function loadMeta() {
    if (!META_PIXEL_ID || window.fbq) return;
    var n = (window.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    });
    if (!window._fbq) window._fbq = n;
    n.push = n;
    n.loaded = true;
    n.version = "2.0";
    n.queue = [];
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://connect.facebook.net/en_US/fbevents.js";
    document.head.appendChild(s);
    window.fbq("init", META_PIXEL_ID);
    window.fbq("track", "PageView");
  }

  function loadGoogle() {
    if (!GOOGLE_TAG_IDS.length || window.gtag) return;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () {
      window.dataLayer.push(arguments);
    };
    window.gtag("js", new Date());
    GOOGLE_TAG_IDS.forEach(function (id) {
      window.gtag("config", id);
    });
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(GOOGLE_TAG_IDS[0]);
    document.head.appendChild(s);
  }

  function start() {
    loadMeta();
    loadGoogle();
  }

  // Clique em "Testar grátis" = Lead (Meta) e generate_lead (GA4): público de quem quis testar e não cadastrou.
  document.addEventListener("click", function (event) {
    var link = event.target instanceof Element && event.target.closest('a[href^="/cadastro"]');
    if (!link || read() !== true) return;
    if (META_PIXEL_ID && window.fbq) window.fbq("track", "Lead");
    if (GOOGLE_TAG_IDS.length && window.gtag) window.gtag("event", "generate_lead", { method: "testar_gratis" });
  });

  function button(label, primary, onPick) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText =
      "height:36px;padding:0 14px;border-radius:6px;font:500 13px/1 Inter,system-ui,sans-serif;cursor:pointer;" +
      "border:1px solid " + (primary ? "#1A1814" : "#DDD8D0") + ";" +
      "background:" + (primary ? "#1A1814" : "#FFFFFF") + ";color:" + (primary ? "#F7F4EF" : "#1A1814");
    b.addEventListener("click", function () {
      // Guard de duplo clique (regra 6).
      if (b.disabled) return;
      b.disabled = true;
      onPick();
    });
    return b;
  }

  function banner() {
    var box = document.createElement("div");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Aviso de cookies");
    box.style.cssText =
      "position:fixed;left:16px;right:16px;bottom:16px;max-width:640px;margin:0 auto;z-index:60;background:#FFFFFF;color:#1A1814;" +
      "border:1px solid #DDD8D0;border-radius:8px;padding:16px;font:400 13px/1.5 Inter,system-ui,sans-serif;" +
      "box-shadow:0 10px 30px -12px rgba(0,0,0,.4);display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between";

    var text = document.createElement("p");
    text.style.cssText = "margin:0;flex:1 1 280px";
    text.appendChild(document.createTextNode("Usamos cookies de medição de anúncios (Meta e Google) para mostrar o Dish Desk a quem já visitou o site. Você escolhe. "));
    var link = document.createElement("a");
    link.href = "/privacidade";
    link.textContent = "Política de privacidade";
    link.style.cssText = "color:#C4341A;font-weight:500";
    text.appendChild(link);
    text.appendChild(document.createTextNode("."));

    var actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px";
    function choose(granted) {
      save(granted);
      box.remove();
      if (granted) start();
    }
    actions.appendChild(button("Recusar", false, function () { choose(false); }));
    actions.appendChild(button("Aceitar", true, function () { choose(true); }));

    box.appendChild(text);
    box.appendChild(actions);
    document.body.appendChild(box);
  }

  var state = read();
  if (state === true) start();
  else if (state === null) banner();
})();
