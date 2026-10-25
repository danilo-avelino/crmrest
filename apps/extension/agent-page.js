// Agente de implantação e suporte (E31): lê a página da aba e executa a ação que a IA decidiu. A extensão injeta este
// arquivo na aba (background.js) só quando o agente precisa; ele não fica rodando nas páginas.
// A leitura é a árvore dos elementos com que dá para interagir, sem capturas de tela. Valor de senha, código e cartão
// nunca sai da página.

(() => {
  if (window.__dishdeskAgent) return;

  const MAX_ELEMENTS = 400;
  const MAX_TEXT = 6000;
  const INTERACTIVE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable="true"], ' +
    '[role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="textbox"]';
  const HEADINGS = "h1, h2, h3";

  const ROLE = {
    a: "link",
    button: "botão",
    select: "lista",
    textarea: "campo",
    summary: "botão",
    h1: "título",
    h2: "título",
    h3: "título",
  };
  const ARIA_ROLE = {
    button: "botão",
    link: "link",
    checkbox: "caixa de seleção",
    radio: "opção",
    switch: "interruptor",
    tab: "aba",
    menuitem: "item de menu",
    option: "opção",
    combobox: "lista",
    textbox: "campo",
  };

  function roleOf(element) {
    const aria = element.getAttribute("role");
    if (aria && ARIA_ROLE[aria]) return ARIA_ROLE[aria];
    if (element.isContentEditable) return "campo";
    const tag = element.tagName.toLowerCase();
    if (tag !== "input") return ROLE[tag] ?? tag;
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (type === "checkbox") return "caixa de seleção";
    if (type === "radio") return "opção";
    if (["submit", "button", "reset"].includes(type)) return "botão";
    return "campo";
  }

  const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);

  function nameOf(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText)
        .join(" ");
      if (clean(text)) return clean(text);
    }
    const label = element.getAttribute("aria-label") ?? (element.labels?.length ? [...element.labels].map((item) => item.innerText).join(" ") : null);
    if (clean(label)) return clean(label);
    if (element.tagName === "INPUT" && ["submit", "button"].includes(element.type) && element.value) return clean(element.value);
    const text = element.tagName === "SELECT" ? "" : element.innerText;
    return clean(text) || clean(element.getAttribute("placeholder")) || clean(element.getAttribute("title")) || clean(element.querySelector("img")?.alt) || clean(element.getAttribute("name"));
  }

  /** Senha, código de verificação ou cartão, pelo tipo e pelo autocomplete do campo. */
  function sensitiveOf(element) {
    const type = (element.getAttribute("type") ?? "").toLowerCase();
    const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
    if (type === "password" || autocomplete.includes("password")) return "password";
    if (autocomplete.includes("one-time-code")) return "code";
    if (autocomplete.startsWith("cc-") || autocomplete.includes(" cc-")) return "card";
    return undefined;
  }

  function visible(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }

  let nextRef = 1;

  function onScreen(element) {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }

  function snapshot() {
    const elements = [];
    // O que está na tela vem antes (ex.: a gaveta aberta por cima de uma lista longa): a IA lê a lista cortada no fim.
    const found = [...document.querySelectorAll(`${INTERACTIVE}, ${HEADINGS}`)].filter(visible);
    for (const element of [...found.filter(onScreen), ...found.filter((item) => !onScreen(item))]) {
      if (elements.length >= MAX_ELEMENTS) break;
      // O mesmo elemento mantém o número entre as leituras (a IA pode citar o de antes).
      let ref = Number(element.dataset.ddRef);
      if (!ref) {
        ref = nextRef++;
        element.dataset.ddRef = String(ref);
      }
      const role = roleOf(element);
      const sensitive = sensitiveOf(element);
      const item = { ref, role, name: nameOf(element) };
      if (sensitive) item.sensitive = sensitive;
      if ((element.tagName === "INPUT" || element.tagName === "TEXTAREA") && !["checkbox", "radio", "submit", "button"].includes(element.type)) {
        if (element.value && !sensitive) item.value = clean(element.value);
      }
      if (element.tagName === "SELECT") {
        item.options = [...element.options].slice(0, 30).map((option) => clean(option.text).slice(0, 100));
        if (element.selectedOptions[0]) item.value = clean(element.selectedOptions[0].text);
      }
      if (element.type === "checkbox" || element.type === "radio") item.checked = element.checked;
      else if (element.hasAttribute("aria-checked")) item.checked = element.getAttribute("aria-checked") === "true";
      if (element.disabled || element.getAttribute("aria-disabled") === "true") item.disabled = true;
      elements.push(item);
    }
    // Um modal ou uma gaveta aberta: o texto dela vem antes do resto da página.
    const overlay = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')].filter(visible).at(-1);
    const text = `${overlay ? `${overlay.innerText} | ` : ""}${document.body?.innerText ?? ""}`.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
    return { url: location.href, title: document.title.slice(0, 300), elements, text };
  }

  function find(ref) {
    const element = document.querySelector(`[data-dd-ref="${Number(ref)}"]`);
    if (!element) throw new Error(`O elemento [${ref}] não está mais na página.`);
    return element;
  }

  function setValue(element, value) {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Código em caixinhas (uma letra por campo): a partir da caixa dada, põe uma letra em cada campo livre, pulando o "-" fixo. */
  function fillSegmented(first, value) {
    let box = first.parentElement;
    while (box && box.querySelectorAll('input[maxlength="1"]').length < 4) box = box.parentElement;
    if (!box) return false;
    const boxes = [...box.querySelectorAll('input[maxlength="1"]')].filter((item) => !item.disabled && !item.readOnly && item.value !== "-");
    const chars = value.replace(/[^0-9a-z]/gi, "").split("");
    boxes.slice(boxes.indexOf(first)).forEach((item, index) => {
      if (index >= chars.length) return;
      item.focus();
      setValue(item, chars[index]);
    });
    return true;
  }

  /** Escreve como se fosse digitado: o React só enxerga o valor posto pelo setter nativo, seguido do evento. */
  function fill(element, value) {
    if (sensitiveOf(element)) throw new Error("A IA não preenche senha, código nem cartão.");
    element.focus();
    if (element.maxLength === 1 && fillSegmented(element, value)) return;
    if (element.isContentEditable) {
      document.execCommand("selectAll");
      document.execCommand("insertText", false, value);
      return;
    }
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function select(element, value) {
    if (element.tagName !== "SELECT") return element.click();
    const option = [...element.options].find((item) => clean(item.text) === value || item.value === value);
    if (!option) throw new Error(`A opção "${value}" não está na lista.`);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(element, option.value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function act(action) {
    const element = find(action.ref);
    element.scrollIntoView({ block: "center", behavior: "instant" });
    if (action.type === "click") element.click();
    else if (action.type === "fill") fill(element, String(action.value ?? ""));
    else if (action.type === "select") select(element, String(action.value ?? ""));
    else throw new Error(`Ação desconhecida: ${action.type}`);
  }

  /** "Sua vez": rola até o campo que o parceiro preenche e põe o foco nele. */
  function focus(ref) {
    const element = find(ref);
    element.scrollIntoView({ block: "center", behavior: "instant" });
    element.focus();
  }

  // ---------- Indicador na página (board da extensão) ----------
  // A faixa no topo diz que o Dish Desk controla a aba (ou está pausado, ou esperando o parceiro); o contorno marca o
  // elemento em que a IA vai clicar ou que vai preencher (tomate) e o campo que é a vez do parceiro (âmbar). Fica num
  // shadow DOM, para o estilo do site não mexer nele.

  const BANNER = {
    controlling: { text: "O Dish Desk está controlando esta aba", link: "Pausar", event: "pause", bg: "#FDECEA", line: "#F5B5AC", ink: "#9B2414" },
    paused: { text: "Dish Desk pausado · você está no controle", link: "Continuar", event: "resume", bg: "#F0EDE8", line: "#DDD8D0", ink: "#4A4540" },
    waiting: { text: "O Dish Desk está esperando você nesta aba", bg: "#FEF9EC", line: "#F0D88A", ink: "#7A5008" },
  };
  const MARK = {
    click: { label: "IA clicando", color: "#C4341A", shadow: "rgba(196,52,26,.15)" },
    fill: { label: "IA preenchendo", color: "#C4341A", shadow: "rgba(196,52,26,.15)" },
    your_turn: { label: "Sua vez", color: "#B45309", shadow: "rgba(180,83,9,.15)" },
  };
  const LOGO =
    '<svg width="16" height="16" viewBox="0 0 16 16" style="flex-shrink:0;background:#1A1814;border-radius:4px"><rect x="3" y="4" width="10" height="1.5" rx=".75" fill="#F7F4EF"/><rect x="3" y="7.25" width="7" height="1.5" rx=".75" fill="#F7F4EF"/><rect x="3" y="10.5" width="4.5" height="1.5" rx=".75" fill="#C4341A"/></svg>';

  let state = "off";
  let marked = null;
  let host = null;

  function overlay() {
    if (host?.isConnected) return host.shadowRoot;
    host = document.createElement("div");
    host.id = "dishdesk-agent-overlay";
    host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      * { box-sizing: border-box; font-family: Inter, system-ui, sans-serif; }
      .banner { position: fixed; top: 0; left: 0; right: 0; display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 14px; font-size: 12.5px; font-weight: 600; border-bottom: 1px solid; pointer-events: auto; }
      .banner[hidden], .mark[hidden] { display: none; }
      .banner button { all: unset; cursor: pointer; text-decoration: underline; font-weight: 500; }
      .dot { opacity: .5; }
      .mark { position: fixed; border: 2px solid; border-radius: 8px; }
      .label { position: absolute; top: -22px; left: -2px; padding: 2px 7px; border-radius: 4px; color: #fff; font-size: 11px; font-weight: 700; white-space: nowrap; }
    </style><div class="banner" hidden></div><div class="mark" hidden><span class="label"></span></div>`;
    root.querySelector(".banner").addEventListener("click", (event) => {
      if (event.target.closest("button")) chrome.runtime.sendMessage({ dishdeskAgent: event.target.closest("button").dataset.event });
    });
    document.documentElement.append(host);
    return root;
  }

  function place() {
    const box = host?.shadowRoot?.querySelector(".mark");
    if (!box || !marked?.element.isConnected) return box && (box.hidden = true);
    const rect = marked.element.getBoundingClientRect();
    Object.assign(box.style, { top: `${rect.top - 4}px`, left: `${rect.left - 4}px`, width: `${rect.width + 8}px`, height: `${rect.height + 8}px` });
    box.hidden = false;
  }

  function mark(ref, kind) {
    const root = overlay();
    let element = null;
    try {
      element = ref ? find(ref) : null;
    } catch {
      element = null;
    }
    marked = element ? { element, kind } : null;
    if (!marked) return place();
    const style = MARK[kind];
    const box = root.querySelector(".mark");
    Object.assign(box.style, { borderColor: style.color, boxShadow: `0 0 0 4px ${style.shadow}` });
    const label = root.querySelector(".label");
    label.textContent = style.label;
    label.style.background = style.color;
    element.scrollIntoView({ block: "center", behavior: "instant" });
    place();
  }

  /** O estado da faixa (controlling, paused, waiting ou off) e, se houver, o elemento marcado. */
  function indicate({ state: next, ref, mark: kind }) {
    state = next;
    if (next === "off") {
      host?.remove();
      host = null;
      marked = null;
      return;
    }
    const banner = overlay().querySelector(".banner");
    const style = BANNER[next];
    Object.assign(banner.style, { background: style.bg, borderColor: style.line, color: style.ink });
    banner.innerHTML = `${LOGO}<span></span>${style.link ? `<span class="dot">·</span><button type="button" data-event="${style.event}">${style.link}</button>` : ""}`;
    banner.querySelector("span").textContent = style.text;
    banner.hidden = false;
    if (kind === "your_turn") mark(ref, "your_turn");
    else if (next === "waiting" && ref) mark(ref, "click");
    else if (next !== "controlling") mark(null);
  }

  /** Antes de agir, o contorno no elemento: "IA clicando" ou "IA preenchendo". */
  function highlight(ref, kind) {
    mark(ref, kind);
  }

  addEventListener("scroll", place, true);
  addEventListener("resize", place);
  // O parceiro clicou ou digitou na página enquanto a IA agia: ela pausa (as ações da IA não são "isTrusted").
  for (const type of ["pointerdown", "keydown"]) {
    addEventListener(
      type,
      (event) => {
        if (state !== "controlling" || !event.isTrusted || (host && event.composedPath().includes(host))) return;
        chrome.runtime.sendMessage({ dishdeskAgent: "user-input" });
      },
      true,
    );
  }

  window.__dishdeskAgent = { snapshot, act, focus, indicate, highlight };
})();
