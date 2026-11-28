import type { BlogPost } from "@/lib/blog/types";

/** Página pilar: liga todas as partes da operação e aponta para os artigos de cada uma. */
export const pilarPost: BlogPost = {
  slug: "operacao-de-delivery",
  title: "Operação de delivery: o guia do dono de restaurante",
  seoTitle: "Operação de delivery: guia do dono de restaurante",
  description:
    "Como organizar a operação de delivery do restaurante: atendimento nos apps e no WhatsApp, avaliações, tempo de despacho, cliente próprio e embalagem.",
  topic: "Guia",
  publishedAt: "2026-11-28",
  related: ["tempo-de-preparo-x-tempo-de-despacho", "contestar-avaliacao-ifood"],
  cta: {
    title: "Todos os canais num painel só",
    text: "O Dish Desk junta WhatsApp, Instagram e o chat do iFood numa caixa de entrada, com o pedido e o histórico do cliente ao lado da conversa.",
  },
  faq: [
    {
      question: "O que é operação de delivery?",
      answer:
        "É o conjunto de etapas entre o pedido chegar e a comida ser entregue: atendimento, produção, despacho, entrega e pós-venda. Inclui também a reputação nos apps e o relacionamento com quem já pediu.",
    },
    {
      question: "Qual o indicador mais importante do delivery?",
      answer:
        "Não existe um só, mas o tempo até o pedido sair da loja é o que mais aparece nas reclamações de atraso e de comida fria. Comece por ele e pelo tempo da primeira resposta nas mensagens.",
    },
    {
      question: "Vale a pena ter canal próprio além do iFood?",
      answer:
        "Para a maioria dos restaurantes, sim, como complemento. O app traz cliente novo. O canal próprio é onde quem já conhece a loja pode pedir de novo sem a comissão do app.",
    },
  ],
  body: `
A operação de delivery é tudo o que acontece entre o cliente abrir o app e a comida chegar boa na mão dele: atender, produzir, despachar e fazer esse cliente voltar. Quando uma parte falha, a nota cai e o pedido seguinte não vem.

Este guia junta as sete partes da operação e diz, para cada uma, o que olhar primeiro. Cada parte ganha artigos próprios aqui no blog.

> **Na nossa operação**
>
> {{PREENCHER: em duas ou três frases, quem escreve este blog e que operação roda hoje (por exemplo, quantas marcas e quantos pedidos por mês), só com os números que você aceita mostrar.}}

## O que entra na operação de delivery?

Sete partes, da mais ligada ao dia a dia para a mais estrutural:

1. **Atendimento em vários canais:** responder iFood, 99Food, Keeta, WhatsApp e Instagram sem perder mensagem.
2. **Reputação e avaliações:** a nota da loja e o que fazer com cada avaliação.
3. **Tempo e logística:** preparo, despacho e a espera entre a cozinha e o entregador.
4. **Cliente próprio e recompra:** saber quem pede, quem sumiu e como fazer voltar.
5. **Cardápio e preço no delivery:** o que vender em cada canal e por quanto.
6. **Embalagem e qualidade na chegada:** a comida chegar como saiu da cozinha.
7. **Dark kitchen e várias marcas:** rodar mais de uma marca na mesma cozinha.

## Atendimento: como não perder mensagem em vários canais?

Junte os canais num lugar só e defina quem responde cada um em cada turno. O problema raramente é falta de gente. É a mensagem que chega no canal que ninguém está olhando.

- Liste todos os canais por onde o cliente fala com você, inclusive o chat de cada app.
- Meça quanto tempo leva a primeira resposta no horário de pico. É esse número que decide se o cliente espera ou desiste.
- Tenha respostas prontas para o que se repete: "cadê meu pedido?", "faltou um item", "posso trocar?".

## Avaliações: o que fazer quando a nota cai?

Responda as avaliações negativas dentro do prazo e trate a causa, não só a avaliação. No iFood, a nota da loja é a média das avaliações públicas dos últimos 90 dias. Uma semana ruim pesa por três meses.

Uma avaliação injusta quase nunca é removida, mas a resposta certa pode fazer o cliente rever a nota. O passo a passo está em [como contestar avaliação injusta no iFood](/blog/contestar-avaliacao-ifood).

## Tempo: por que o pedido atrasa se a cozinha foi rápida?

Porque o cliente não sente o tempo de preparo. Ele sente o tempo até a comida sair da loja. Entre o pedido pronto e a saída com o entregador cabe uma espera que nenhum relatório de cozinha mostra.

Separe os dois números e meça cada um no pico. A diferença, e como fechar esse buraco, está em [tempo de preparo x tempo de despacho](/blog/tempo-de-preparo-x-tempo-de-despacho).

## Cliente próprio: como saber quem parou de pedir?

Tenha um cadastro por cliente, juntando quem pede no app e quem chama no WhatsApp. Com isso dá para ver de quanto em quanto tempo cada um pede e perceber quando passou do ponto.

- Anote o intervalo normal de compra dos seus clientes recorrentes.
- Trate como sumido quem passou bem desse intervalo, e fale com ele antes de perdê-lo de vez.
- Junte cadastros repetidos: o mesmo cliente com três telefones vira três clientes pela metade.

## Cardápio e preço: o cardápio do app precisa ser igual ao próprio?

Não precisa. Cada canal tem um custo diferente, e o preço precisa cobrir a comissão e as taxas de cada um. O que precisa ser igual é o prato: o que chega tem que ser o da foto.

- Calcule a margem de cada item depois do custo de cada canal.
- Tire do delivery o que não viaja bem, mesmo que venda no salão.
- Acompanhe os itens que mais geram cancelamento ou reclamação.

## Embalagem: como a comida chega como saiu da cozinha?

Teste a embalagem com o tempo real de entrega, não com o tempo do balcão. Monte um pedido, espere o tempo de despacho mais o de entrega da sua loja e só então abra. É assim que o cliente recebe.

## Várias marcas na mesma cozinha: o que muda?

Cada marca precisa de cardápio, atendimento e reputação próprios, mesmo saindo da mesma cozinha. O cliente avalia a marca, não a cozinha, e o problema de uma marca não pode virar o problema das outras.

## Por onde começar?

Comece pelo que mais gera avaliação negativa hoje. Para a maioria das operações, é tempo ou atendimento:

1. Meça o tempo de despacho no pico por uma semana.
2. Meça o tempo da primeira resposta nos canais de mensagem.
3. Leia as últimas 30 avaliações negativas e conte os motivos.

O motivo que mais aparece é o primeiro a atacar.
`,
};
