# Extensão Dish Desk · iFood

O iFood não tem API de chat: a conversa com o cliente só existe no widget, um iframe de `embeddables.ifood.com.br` que o painel não consegue ler. Esta extensão do Chrome roda dentro desse iframe e serve de ponte para o painel do Dish Desk.

**Estado (13/10/2026):** versão 0.2.0. A ponte lê o widget e também clica e digita nele. A API já recebe a conversa e guarda as respostas da Inbox; falta o painel ler o chat do widget e digitar as respostas (depende de mapear a estrutura do chat com a extensão carregada).

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
// resposta (evento "message" na janela do painel): { dishdesk: "ifood-bridge", id: 1, ok: true, version: "0.2.0" }
```

| Operação | Pedido | Resposta |
|---|---|---|
| `ping` | — | `version`: versão da extensão instalada |
| `html` | `selector` (opcional) | `html`: lista com o HTML de cada elemento do seletor; sem seletor, a página inteira do widget |
| `click` | `selector`, `index` (opcional) | — |
| `fill` | `selector`, `index` (opcional), `text` | — (escreve no campo como se fosse digitado) |
| `key` | `selector`, `index` (opcional), `key` | — (tecla no elemento, ex.: `Enter`) |

`index` escolhe entre os elementos do seletor (o primeiro, se faltar). Elemento não encontrado é erro.

Um erro volta como `{ ok: false, error }`.

## Limites conhecidos

- O widget precisa estar autorizado pela loja (Portal do Parceiro do iFood), uma vez por computador. A sessão cai depois de 7 dias sem uso.
- A leitura depende do HTML do widget, que o iFood muda sem aviso. Por isso os seletores ficam no painel, e não aqui.
- As mensagens só são lidas enquanto houver um painel aberto num Chrome com a extensão e o widget autorizado. Uma resposta escrita na Inbox espera 60 segundos por um painel assim; sem ele, aparece como falha e pode ser reenviada.
- O widget não mostra o id das mensagens nem o dia: a Inbox identifica cada uma pelo pedido, hora e texto, e usa o dia do pedido.
- O iFood pede que o widget seja controlado só pela API JavaScript oficial. Ler e escrever no iframe foge disso: é uma decisão do produto, com risco de o iFood barrar na homologação ou depois.
