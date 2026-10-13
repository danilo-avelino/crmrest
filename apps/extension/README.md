# Extensão Dish Desk · iFood

O iFood não tem API de chat: a conversa com o cliente só existe no widget, um iframe de `embeddables.ifood.com.br` que o painel não consegue ler. Esta extensão do Chrome roda dentro desse iframe e serve de ponte para o painel do Dish Desk.

**Estado (13/10/2026):** versão 0.1.0, só leitura. Serve para mapear a estrutura do chat do widget. Levar as mensagens para a Inbox e responder por ela são os próximos passos.

## Instalar (modo desenvolvedor)

1. Abra `chrome://extensions` e ligue o **Modo do desenvolvedor** (canto superior direito).
2. Clique em **Carregar sem compactação** e escolha a pasta `apps/extension`.
3. Recarregue a aba do Dish Desk.

Depois de mudar um arquivo da extensão, clique em recarregar (seta circular) no card dela em `chrome://extensions` e recarregue a aba do Dish Desk.

## Como funciona

A ponte só atende pedidos vindos do painel (`https://www.dishdesk.com.br` e `http://localhost:3000`) e só quando o widget está dentro dele. O painel fala com o iframe do widget por `postMessage`:

```js
iframe.contentWindow.postMessage({ dishdesk: "ifood-bridge", id: 1, op: "ping" }, "https://embeddables.ifood.com.br");
// resposta (evento "message" na janela do painel): { dishdesk: "ifood-bridge", id: 1, ok: true, version: "0.1.0" }
```

| Operação | Pedido | Resposta |
|---|---|---|
| `ping` | — | `version`: versão da extensão instalada |
| `html` | `selector` (opcional) | `html`: lista com o HTML de cada elemento do seletor; sem seletor, a página inteira do widget |

Um erro volta como `{ ok: false, error }`.

## Limites conhecidos

- O widget precisa estar autorizado pela loja (Portal do Parceiro do iFood), uma vez por computador. A sessão cai depois de 7 dias sem uso.
- A leitura depende do HTML do widget, que o iFood muda sem aviso. Por isso os seletores ficam no painel, e não aqui.
- As mensagens só são lidas enquanto houver um painel aberto num Chrome com a extensão e o widget autorizado.
- O iFood pede que o widget seja controlado só pela API JavaScript oficial. Ler e escrever no iframe foge disso: é uma decisão do produto, com risco de o iFood barrar na homologação ou depois.
