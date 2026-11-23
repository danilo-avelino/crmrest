/* Demo interativa do Dish Desk, no estilo do Getdemo: as telas são o HTML do painel de verdade, capturado da conta demo
   (states/NN.html, feitos por Videos/dish-desk/demo-interativa/captura.mjs), cada uma num iframe de 1440 × 900
   escalado para a largura da página. Cada passo mostra uma tela, contorna um alvo (marcado com data-aim na captura) e
   espera o clique: no botão inteiro do app ou em "Próximo". A narração de cada passo está em audio/NN.mp3
   (ElevenLabs, voz Bianca; gerada por Videos/dish-desk/demo-interativa/narracao.mjs). */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const W = 1440;

  const STATES = {
    '01-inbox': '/inbox',
    '02-automaticos': '/inbox',
    '11-ia': '/inbox',
    '12-revisada': '/inbox',
    '13-original': '/inbox',
    '14-sugerir': '/inbox',
    '15-sugestao': '/inbox',
    '16-fraude': '/inbox',
    '17-motivo': '/inbox',
    '18-marcar': '/inbox',
    '19-confirmar': '/inbox',
    '20-cancelado': '/inbox',
    '03-entregador': '/inbox',
    '05-cliente': '/inbox',
    '06-avaliacoes': '/avaliacoes',
    '07-assuntos': '/avaliacoes',
    '08-atendimentos': '/avaliacoes/atendimentos',
    '09-equipe': '/avaliacoes/equipe',
    '10-clientes': '/clientes',
  };
  const CHAPTERS = ['Inbox', 'IA responde', 'Sugestão da IA', 'Alerta de fraude', 'Entregador', 'Avaliações', 'Equipe', 'Clientes', 'Teste grátis'];
  // state: a tela; aim: o alvo (data-aim da captura); hot: o clique no alvo avança; a fala é audio/<número do passo>.mp3.
  const BEATS = [
    { ch: 0, state: '01-inbox', aim: 'integ', side: 'bottom', title: 'Todos os canais numa tela só', text: 'WhatsApp, Instagram e iFood chegam na mesma Inbox. Os pedidos do Cardápio Web também.' },
    { ch: 0, state: '01-inbox', aim: 'semequipe', side: 'bottom', title: 'Quase metade, só com a IA', text: 'Das conversas de hoje, perto de 45% terminaram sem ninguém da equipe: a IA e as automações resolveram.' },
    { ch: 0, state: '01-inbox', aim: 'aba-auto', hot: true, side: 'right', title: 'O que a IA faz sozinha', text: 'Aqui ficam as conversas que a IA e as automações estão cuidando. Clique em Automáticos.' },
    { ch: 1, state: '02-automaticos', aim: 'joao', hot: true, side: 'right', title: 'Cadê meu pedido?', text: 'O João perguntou se o motoboy já saiu. Clique na conversa dele.' },
    { ch: 1, state: '11-ia', aim: 'respostaia', side: 'left', title: 'A IA responde com o pedido certo', text: 'Ela acha o pedido e conta o status real, com a previsão de entrega. Ao lado, sua equipe vê o pedido e o cadastro do cliente.' },
    { ch: 1, state: '12-revisada', aim: 'veroriginal', hot: true, side: 'top', title: 'A IA melhora o texto da equipe', text: 'Antes de sair, a resposta da Júlia foi revisada pela IA, para a cliente receber uma mensagem mais agradável. Clique em “ver original”.' },
    { ch: 1, state: '13-original', aim: 'original', side: 'left', title: 'Antes e depois', text: 'A Júlia escreveu “desculpa, ja to mandando outra”. A cliente recebeu um pedido de desculpas com a solução e o prazo.' },
    { ch: 2, state: '14-sugerir', aim: 'sugerir', hot: true, side: 'top', title: 'Sua equipe atende com a IA do lado', text: 'O Nicolas quer saber se vocês entregam no Ipiranga. Clique em Sugerir com IA.' },
    { ch: 2, state: '15-sugestao', aim: 'composer', side: 'top', title: 'Revise e envie', text: 'A resposta vem pronta, no tom do seu restaurante. É só revisar e enviar.' },
    { ch: 3, state: '15-sugestao', aim: 'fraude-item', hot: true, side: 'right', title: 'Um pedido suspeito', text: 'Este pedido chegou com alerta de fraude. Clique na conversa.' },
    { ch: 3, state: '16-fraude', aim: 'alerta-fraude', side: 'bottom', title: 'O pedido chega com alerta', text: 'A Priscila cancelou 3 dos 6 pedidos que fez. O Dish Desk mostra cada cancelamento, com o valor e o motivo.' },
    { ch: 3, state: '16-fraude', aim: 'cancelar', hot: true, side: 'left', title: 'Cancele por aqui', text: 'Desconfiou? Clique em Cancelar pedido.' },
    { ch: 3, state: '17-motivo', aim: 'motivo', hot: true, side: 'right', title: 'Escolha o motivo', text: 'Os motivos são os que o iFood aceita. Clique em “Suspeita de golpe ou pedido falso”.' },
    { ch: 3, state: '18-marcar', aim: 'marcar', hot: true, side: 'right', title: 'Marque como fraude', text: 'Os próximos pedidos para este endereço vão mostrar este pedido no alerta.' },
    { ch: 3, state: '19-confirmar', aim: 'confirmar', hot: true, side: 'right', title: 'Confirme o cancelamento', text: 'Clique em Cancelar pedido.' },
    { ch: 3, state: '20-cancelado', aim: 'decisao', side: 'bottom', title: 'Cancelado e registrado', text: 'Fica quem cancelou, a hora e a marca de fraude. Os próximos pedidos para esse endereço já chegam com o alerta.' },
    { ch: 4, state: '20-cancelado', aim: 'aba-auto2', hot: true, side: 'right', title: 'O entregador chegou', text: 'Agora, as automações do entregador. Clique em Automáticos.' },
    { ch: 4, state: '02-automaticos', aim: 'entregador', hot: true, side: 'right', title: 'Aviso do entregador', text: 'O Wellington avisou pelo WhatsApp que chegou com o pedido. Clique na conversa dele.' },
    { ch: 4, state: '03-entregador', aim: 'aviso', side: 'right', title: 'A cliente foi avisada', text: 'O Dish Desk achou o pedido e avisou a cliente no chat do iFood. Ninguém da equipe precisou parar.' },
    { ch: 4, state: '05-cliente', aim: 'avisocliente', side: 'bottom', title: 'Do lado da cliente', text: 'O Dish Desk abriu a conversa da Tatiane no iFood: “o entregador está na sua porta”, no tom do seu restaurante. Quando ele deixa na portaria, o aviso é outro.' },
    { ch: 5, state: '05-cliente', aim: 'rail-aval', hot: true, side: 'right', title: 'Avaliações', text: 'Clique na estrela, no menu ao lado.' },
    { ch: 5, state: '06-avaliacoes', aim: 'notaia', side: 'bottom', title: 'Nota para cada atendimento', text: 'A IA lê cada atendimento resolvido pela equipe e dá uma nota de 1% a 100%.' },
    { ch: 5, state: '06-avaliacoes', aim: 'conduta', side: 'bottom', title: 'Má conduta não chega ao cliente', text: 'Resposta ofensiva da equipe é bloqueada pela IA e vira um alerta para você.' },
    { ch: 5, state: '07-assuntos', aim: 'assuntos', side: 'top', title: 'Por que o cliente chama', text: 'Os assuntos dos atendimentos e o que deu errado, com a falha separada entre o atendimento e a cozinha ou a entrega.' },
    { ch: 5, state: '07-assuntos', aim: 'nav-atend', hot: true, side: 'right', title: 'Um por um', text: 'Clique em Atendimentos.' },
    { ch: 5, state: '08-atendimentos', aim: 'errado', side: 'bottom', title: 'Nota, assunto e o que deu errado', text: 'Cada atendimento com quem atendeu, se resolveu, a reação do cliente e o risco de perdê-lo.' },
    { ch: 6, state: '08-atendimentos', aim: 'nav-equipe', hot: true, side: 'right', title: 'A sua equipe', text: 'Clique em Equipe.' },
    { ch: 6, state: '09-equipe', aim: 'tempo', side: 'bottom', title: 'Tempo de resposta', text: 'O tempo médio da 1ª resposta, desde que a automação chamou a equipe. Mais abaixo, o de cada atendente.' },
    { ch: 6, state: '09-equipe', aim: 'alerta', side: 'bottom', title: 'Alertas de má conduta', text: 'Quem escreveu, a mensagem original e o motivo da IA. A mensagem não foi enviada ao cliente.' },
    { ch: 7, state: '09-equipe', aim: 'rail-clientes', hot: true, side: 'right', title: 'Sua base de clientes', text: 'Clique em Clientes.' },
    { ch: 7, state: '10-clientes', aim: 'tags', side: 'right', title: 'Tags automáticas', text: 'VIP, Recorrente, Novo e Sumido: o Dish Desk classifica cada cliente pelos pedidos que fez. Em breve: campanhas e ofertas para cada tag, de recorrência, recuperação e mais.' },
    { ch: 8, end: true },
  ];

  const tour = $('#tour'), box = $('#box'), frame = $('#frame'), screen = $('#screen');
  const tip = $('#tip'), hot = $('#hot'), hit = $('#hit'), ring = $('#ring'), audio = new Audio();
  audio.preload = 'auto';
  let cur = -1, sound = true, k = 1;

  // ---------------- as telas: um iframe por tela, todos carregados de início (a troca fica instantânea) ----------------
  const frames = {};
  let loaded = 0;
  for (const id of Object.keys(STATES)) {
    const f = document.createElement('iframe');
    f.title = 'Tela do Dish Desk';
    f.tabIndex = -1;
    f.setAttribute('aria-hidden', 'true');
    f.addEventListener('load', () => {
      if (++loaded === Object.keys(STATES).length) ready();
      if (BEATS[cur]?.state === id) place();
    });
    f.src = `states/${id}.html`;
    screen.append(f);
    frames[id] = f;
  }
  function ready() {
    $('#go').disabled = false;
    $('#go').textContent = '▶ Começar a demo';
    $('#go-mute').disabled = false;
  }
  // se alguma tela demorar, não prende o início
  setTimeout(ready, 6000);

  function show(id) {
    for (const [key, f] of Object.entries(frames)) f.classList.toggle('on', key === id);
    $('#url').textContent = 'www.dishdesk.com.br' + STATES[id];
  }

  // ---------------- escala ----------------
  new ResizeObserver(() => {
    k = screen.clientWidth / W;
    frame.style.setProperty('--k', k);
    tour.classList.toggle('docked', box.clientWidth < 760);
    place();
  }).observe(frame);

  // ---------------- capítulos ----------------
  const chapters = $('#chapters');
  CHAPTERS.forEach((name, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<button type="button"><span class="sn">${String(i + 1).padStart(2, '0')}</span>${name}</button>`;
    li.firstChild.addEventListener('click', () => { if ($('#start').hidden) go(BEATS.findIndex((b) => b.ch === i)); });
    chapters.append(li);
  });
  const chapterButtons = $$('button', chapters);

  /** O retângulo do alvo dentro da tela, em pixels da caixa (já escalado). */
  function aimRect(beat) {
    const doc = frames[beat.state]?.contentDocument;
    const el = doc?.querySelector(`[data-aim="${beat.aim}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect(), s = screen.getBoundingClientRect(), b = box.getBoundingClientRect();
    return { x: s.left - b.left + r.left * k, y: s.top - b.top + r.top * k, w: r.width * k, h: r.height * k };
  }

  /** Contorno, área clicável, ponto e balão no alvo do passo atual (também a cada mudança de tamanho). */
  function place() {
    const beat = BEATS[cur];
    if (!beat || beat.end) return;
    const r = aimRect(beat);
    if (!r) return;
    const pad = 4;
    const box4 = { left: r.x - pad + 'px', top: r.y - pad + 'px', width: r.w + pad * 2 + 'px', height: r.h + pad * 2 + 'px' };
    Object.assign(ring.style, box4);
    Object.assign(hit.style, box4);
    hot.style.left = r.x + r.w - 2 + 'px';
    hot.style.top = r.y + 2 + 'px';
    if (tour.classList.contains('docked')) { tip.style.left = tip.style.top = ''; return; }
    const BW = box.clientWidth, BH = frame.offsetHeight, w = tip.offsetWidth, h = tip.offsetHeight, gap = 18;
    let x, y;
    if (beat.side === 'right') { x = r.x + r.w + gap; y = r.y + r.h / 2 - h / 2; }
    else if (beat.side === 'left') { x = r.x - gap - w; y = r.y + r.h / 2 - h / 2; }
    else if (beat.side === 'top') { x = r.x + r.w / 2 - w / 2; y = r.y - gap - h; }
    else { x = r.x + r.w / 2 - w / 2; y = r.y + r.h + gap; }
    // sem espaço do lado pedido, o balão vai para o outro lado
    if (beat.side === 'bottom' && y + h > BH - 8) y = r.y - gap - h;
    if (beat.side === 'top' && y < 8) y = r.y + r.h + gap;
    if (beat.side === 'right' && x + w > BW - 8) x = r.x - gap - w;
    tip.style.left = Math.max(8, Math.min(BW - w - 8, x)) + 'px';
    tip.style.top = Math.max(8, Math.min(BH - h - 8, y)) + 'px';
  }

  function narrate(i) {
    audio.pause();
    audio.src = `audio/${String(i + 1).padStart(2, '0')}.mp3`;
    if (sound) audio.play().catch(() => {});
  }

  /** Entra no passo i: mostra a tela, o alvo e o balão, e toca a fala. */
  function go(i, opts = {}) {
    if (i < 0 || i >= BEATS.length) return;
    const beat = BEATS[i];
    cur = i;
    chapterButtons.forEach((b, j) => {
      if (j === beat.ch) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
      b.classList.toggle('done', j < beat.ch);
    });
    if (!opts.silent) narrate(i);
    $('#end').hidden = !beat.end;
    tip.hidden = ring.hidden = hit.hidden = hot.hidden = true;
    if (beat.end) return;
    show(beat.state);
    $('#tip-n').textContent = `${i + 1} de ${BEATS.length - 1}`;
    $('#tip-t').textContent = beat.title;
    $('#tip-p').textContent = beat.text;
    tip.classList.toggle('hot-step', Boolean(beat.hot));
    $('#back').style.visibility = i > 0 ? 'visible' : 'hidden';
    hit.setAttribute('aria-label', beat.title);
    // a tela nova aparece primeiro; o balão vem logo depois, já no lugar
    setTimeout(() => {
      if (cur !== i) return;
      tip.hidden = ring.hidden = false;
      hit.hidden = hot.hidden = !beat.hot;
      place();
    }, reduced || opts.instant ? 0 : 280);
  }

  hit.addEventListener('click', () => go(cur + 1));
  $('#next').addEventListener('click', () => go(cur + 1));
  $('#back').addEventListener('click', () => go(cur - 1, { instant: true, silent: true }));
  $('#again').addEventListener('click', () => go(0));

  function setSound(on) {
    sound = on;
    const b = $('#sound');
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? 'Som ligado' : 'Som desligado';
    if (!on) audio.pause();
  }
  $('#sound').addEventListener('click', () => setSound(!sound));
  function start(withSound) {
    setSound(withSound);
    $('#start').hidden = true;
    go(0);
  }
  $('#go').addEventListener('click', () => start(true));
  $('#go-mute').addEventListener('click', () => start(false));

  // a próxima fala já baixada, para não esperar a rede no clique
  audio.addEventListener('playing', () => { if (cur + 1 < BEATS.length) fetch(`audio/${String(cur + 2).padStart(2, '0')}.mp3`).catch(() => {}); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) audio.pause(); });

  show('01-inbox');
  window.__demo = { go, beats: BEATS };
})();
