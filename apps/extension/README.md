# Extensão Dish Desk · iFood

O iFood não tem API de chat: a conversa com o cliente só existe no widget, um iframe de `embeddables.ifood.com.br` que o painel não consegue ler. Esta extensão do Chrome roda dentro desse iframe e serve de ponte para o painel do Dish Desk.

**Estado (13/10/2026):** versão 0.3.0. A ponte lê o widget (com a posição de cada elemento), clica e digita nele. O painel copia as conversas para a Inbox e digita as respostas ([ifood-chat-dom.ts](../web/lib/ifood-chat-dom.ts) lê o HTML, [ifood-chat-driver.ts](../web/lib/ifood-chat-driver.ts) decide o que abrir). Falta confirmar com o widget de verdade o lado dos balões (cliente à esquerda, loja à direita) e o campo de resposta: o mapeamento foi feito com uma conversa já encerrada, só com mensagens da loja.

## Trava

A função inteira depende da variável `IFOOD_CHAT_BRIDGE` da `api` (Railway). Sem ela, ou com `false`, o painel não fala com a extensão: o Dish Desk mostra só o widget oficial, as rotas `/api/ifood-chat/*` respondem 404 e a Inbox não deixa responder conversas do iFood. Com `true`, o chat vai para a Inbox. Mudar a variável pede um novo deploy da `api`; a extensão instalada não precisa de nada.

## Instalar (modo desenvolvedor)

1. Abra `chrome://extensions` e ligue o **Modo do desenvolvedor** (canto superior direito).
2. Clique em **Carregar sem compactação** e escolha a pasta `apps/extension`.
3. Recarregue a aba do Dish Desk.

Depois de mudar um arquivo da extensão, clique em recarregar (seta circular) no card dela em `chrome://extensions` e recarregue a aba do Dish Desk.

## Como funciona

A ponte só atende pedidos vindos do painel (`https://www.dishdesk.com.br` e `http://localhost:3000`) e só quando o widget está dentro dele. O painel fala com o iframe do widget por `postMessage`:

```js
iframe.contentWindow.postMessage({ dishdesk: "ifood-bridge", id: 1, op: "ping" }, "https://embeddables.ifood.com.br");
// resposta (evento "message" na janela do painel): { dishdesk: "ifood-bridge", id: 1, ok: true, version: "0.3.0" }
```

| Operação | Pedido | Resposta |
|---|---|---|
| `ping` | — | `version`: versão da extensão instalada |
| `html` | `selector` (opcional), `geometry` (opcional) | `html`: lista com o HTML de cada elemento do seletor; sem seletor, a página inteira do widget. Com `geometry`, cada elemento leva `data-dd-rect="x,y,largura,altura"` |
| `click` | `selector`, `index` (opcional) | — |
| `fill` | `selector`, `index` (opcional), `text` | — (escreve no campo como se fosse digitado) |
| `key` | `selector`, `index` (opcional), `key` | — (tecla no elemento, ex.: `Enter`) |

`index` escolhe entre os elementos do seletor (o primeiro, se faltar). Elemento não encontrado é erro.

Um erro volta como `{ ok: false, error }`.

## Como o painel usa

Com a trava ligada e a extensão 0.3.0 ou mais nova, o painel mantém o widget aberto na aba Chat e **invisível** (ele cobriria a tela). A cada 3 segundos lê a lista de conversas; quando a prévia ou a hora de uma muda, abre a conversa, manda as mensagens para a API e fecha. As respostas da Inbox são digitadas na conversa do pedido. Sem a extensão, com versão antiga ou com a loja sem autorizar o widget, o widget aparece como sempre e nada é copiado.

Quando o widget carrega e a extensão não responde, a Inbox mostra um aviso. O botão **Instalar** do aviso abre a página da extensão na Chrome Web Store, que vem da variável `IFOOD_EXTENSION_URL` da `api`; sem a variável, o aviso sai sem o botão. A extensão só entra no widget quando a página carrega: depois de instalar, é preciso recarregar o painel (o aviso oferece o botão **Recarregar**). A permissão para o site do widget é dada na própria instalação; não há outro passo de autorização da extensão.

## Limites conhecidos

- O widget precisa estar autorizado pela loja (Portal do Parceiro do iFood), uma vez por computador. A sessão cai depois de 7 dias sem uso.
- A leitura depende do HTML do widget, que o iFood muda sem aviso. Por isso os seletores ficam no painel, e não aqui.
- As mensagens só são lidas enquanto houver um painel aberto num Chrome com a extensão e o widget autorizado. Uma resposta escrita na Inbox espera 60 segundos por um painel assim; sem ele, aparece como falha e pode ser reenviada.
- O widget não mostra o id das mensagens nem o dia: a Inbox identifica cada uma pelo pedido, hora e texto, e usa o dia do pedido.
- Quem enviou a mensagem vem do lado do balão. Se o painel não conseguir saber o lado, a conversa não é copiada (aviso no console do navegador).
- Com a trava ligada, as abas Notificações e Tracking do widget ficam fora de alcance neste computador, porque o widget fica invisível.
- Numa aba do Chrome em segundo plano o navegador atrasa os temporizadores: a cópia fica mais lenta (até um minuto).
- O iFood pede que o widget seja controlado só pela API JavaScript oficial. Ler e escrever no iframe foge disso: é uma decisão do produto, com risco de o iFood barrar na homologação ou depois.

## Assistente de implantação e suporte (E31)

**Estado (25/10/2026):** versão 0.5.0. O ícone da extensão abre o **painel lateral** ([panel.html](panel.html)), que carrega a página `/extensao/agente` do Dish Desk num iframe (board "Extensão do Chrome · Agente de implantação e suporte"). Enquanto a IA age, a aba mostra a faixa "O Dish Desk está controlando esta aba" e o contorno no elemento ("IA clicando", "IA preenchendo"; "Sua vez" em âmbar no campo do parceiro). Se o parceiro clica ou digita na página durante uma ação, a IA pausa sozinha.

Como funciona:

- A página do Dish Desk no painel tem o login e conduz o ciclo ([agent-driver.ts](../web/lib/agent-driver.ts)): lê a aba, manda para a API (`POST /api/agent/sessions/:id/turn`), executa a ação que voltou e repete até a IA precisar do parceiro.
- [panel.js](panel.js) é a ponte entre a página e a aba que o parceiro está vendo, por `postMessage` (tag `agent-bridge`). Ele injeta [agent-page.js](agent-page.js) na aba só quando precisa.
- [agent-page.js](agent-page.js) lê a árvore dos elementos com que dá para interagir (cada um com um número, `data-dd-ref`), sem capturas de tela, e executa clique, preenchimento e escolha de opção. Valor de senha, código e cartão nunca sai da página.
- As regras obrigatórias ficam na API ([agent-guard.ts](../api/src/agent/agent-guard.ts)): a IA só age nos sites da lista (`AGENT_HOSTS`), nunca preenche senha, código de verificação nem cartão, pede confirmação antes do que não dá para desfazer e não preenche nada que o parceiro não disse ou que não apareceu nas páginas.

| Operação | Pedido | Resposta |
|---|---|---|
| `ping` | — | `version` |
| `snapshot` | — | `page`: endereço, título, elementos e texto da aba |
| `act` | `action`: `click`, `fill`, `select` (com `ref`), `navigate` (com `url`; `newTab: true` abre numa aba nova, que fica ativa) ou `switch` (com `host`: volta a uma aba já aberta, sem recarregar) | — (espera a página carregar) |
| `focus` | `ref` | — (rola até o campo e põe o foco, para o parceiro digitar) |
| `permission` | `host` | `granted`: o Chrome perguntou ao parceiro e ele permitiu |
| `indicate` | `indicator`: `state` (`controlling`, `paused`, `waiting`, `off`), `ref` e `mark` (`your_turn`) | — (a faixa e o contorno na aba) |

Da aba para a página (sem `id`, com `event`): `user-input` (o parceiro mexeu na página enquanto a IA agia), `pause` e `resume` (os links da faixa).

Painel local em dev: no console da extensão (chrome://extensions → Dish Desk → "service worker"), `chrome.storage.local.set({ dishdeskOrigin: "http://localhost:3000" })` e reabrir o painel.

A confirmar no Chrome de verdade, quando a tela existir:

- **Login dentro do painel:** o cookie da sessão é `SameSite=Lax`, e a página roda num iframe dentro da extensão. O Chrome costuma tratar como do mesmo site o iframe de um site para o qual a extensão tem permissão, mas isso precisa ser testado.
- **Permissão de site:** `chrome.permissions.request` exige um clique do parceiro; o clique no iframe deveria valer para o painel.
- **Atualização:** a versão 0.4.0 pede permissões novas (abas, scripts e os sites da implantação). Ao atualizar, o Chrome desliga a extensão até o parceiro aceitar.
- **Cabeçalhos de segurança:** quando o painel ganhar `frame-ancestors`/`X-Frame-Options` (pendência de produção), liberar `chrome-extension://<id da extensão>` para `/extensao/agente`.
