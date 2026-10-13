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

## Limites conhecidos

- O widget precisa estar autorizado pela loja (Portal do Parceiro do iFood), uma vez por computador. A sessão cai depois de 7 dias sem uso.
- A leitura depende do HTML do widget, que o iFood muda sem aviso. Por isso os seletores ficam no painel, e não aqui.
- As mensagens só são lidas enquanto houver um painel aberto num Chrome com a extensão e o widget autorizado. Uma resposta escrita na Inbox espera 60 segundos por um painel assim; sem ele, aparece como falha e pode ser reenviada.
- O widget não mostra o id das mensagens nem o dia: a Inbox identifica cada uma pelo pedido, hora e texto, e usa o dia do pedido.
- Quem enviou a mensagem vem do lado do balão. Se o painel não conseguir saber o lado, a conversa não é copiada (aviso no console do navegador).
- Com a trava ligada, as abas Notificações e Tracking do widget ficam fora de alcance neste computador, porque o widget fica invisível.
- Numa aba do Chrome em segundo plano o navegador atrasa os temporizadores: a cópia fica mais lenta (até um minuto).
- O iFood pede que o widget seja controlado só pela API JavaScript oficial. Ler e escrever no iframe foge disso: é uma decisão do produto, com risco de o iFood barrar na homologação ou depois.
