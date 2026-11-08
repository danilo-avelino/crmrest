// Tráfego do site, medido pelo próprio Dish Desk (Painel da plataforma → Tráfego do site): a página vista e os cliques
// em "Teste grátis". Sem cookie e sem dado pessoal; a API guarda só um hash diário do visitante.
(function () {
  // Quem está com sessão no painel (equipe e restaurantes clientes) não é visitante: o AuthProvider marca o navegador.
  try {
    if (localStorage.getItem("dishdesk_painel")) return;
  } catch (e) {}
  var params = new URLSearchParams(location.search);
  function send(kind) {
    var body = { kind: kind, path: location.pathname };
    if (document.referrer) body.referrer = document.referrer.slice(0, 500);
    var utm = params.get("utm_source");
    if (utm) body.utmSource = utm.slice(0, 100);
    var data = JSON.stringify(body);
    if (navigator.sendBeacon && navigator.sendBeacon("/api/site/visits", new Blob([data], { type: "application/json" }))) return;
    fetch("/api/site/visits", { method: "POST", body: data, headers: { "Content-Type": "application/json" }, keepalive: true }).catch(function () {});
  }
  send("pageview");
  document.addEventListener("click", function (event) {
    var link = event.target instanceof Element && event.target.closest('a[href^="/cadastro"]');
    if (link) send("cta");
  });
})();
