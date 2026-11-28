import type { BlogPost } from "@/lib/blog/types";

export const contestarAvaliacaoPost: BlogPost = {
  slug: "contestar-avaliacao-ifood",
  title: "Como contestar avaliação injusta no iFood: o que é aceito",
  seoTitle: "Contestar avaliação injusta no iFood: o que é aceito",
  description:
    "Avaliação injusta no iFood raramente é removida. Veja o que o iFood descarta, o que fica e como a resposta certa pode fazer o cliente rever a nota.",
  topic: "Reputação e avaliações",
  publishedAt: "2026-11-28",
  related: ["tempo-de-preparo-x-tempo-de-despacho", "operacao-de-delivery"],
  cta: {
    title: "Atendimento do iFood, WhatsApp e Instagram no mesmo lugar",
    text: "O Dish Desk junta o chat do iFood, o WhatsApp e o Instagram numa caixa de entrada, com o pedido ao lado da conversa. As avaliações do iFood entram no painel quando o iFood liberar o acesso.",
  },
  faq: [
    {
      question: "Dá para apagar uma avaliação no iFood?",
      answer:
        "A loja não apaga avaliações. O iFood descarta as que ferem a política, como ofensas e suspeita de fraude. As demais ficam publicadas.",
    },
    {
      question: "Avaliação privada conta na nota da loja?",
      answer:
        "Não. Segundo o iFood, avaliações privadas não contam para a nota média e não aparecem nas avaliações da loja.",
    },
    {
      question: "Por quanto tempo uma avaliação ruim pesa na nota?",
      answer:
        "A nota média da loja considera as avaliações públicas dos últimos 90 dias. Depois disso, a avaliação sai do cálculo.",
    },
  ],
  body: `
Uma avaliação só sai do iFood quando quebra a política de avaliações: ofensa, linguagem inapropriada, assunto da logística do iFood ou suspeita de fraude. Crítica ao sabor, à quantidade ou ao gosto pessoal fica, mesmo que pareça injusta. Para essas, o que funciona é responder em até 5 dias: o cliente é avisado da resposta e pode rever a nota.

As regras abaixo estão no [blog do iFood para parceiros](https://blog-parceiros.ifood.com.br/avaliacoes-e-moderacoes/), conferido em novembro de 2026. Elas mudam com o tempo: confira no seu Portal do Parceiro antes de agir.

## O que o iFood remove sozinho?

Segundo o iFood, antes de chegar à loja são descartados os comentários com:

- ofensas;
- linguagem inapropriada;
- assuntos ligados à logística do iFood;
- suspeita de fraude.

Esses comentários também não contam para a nota da loja. Se uma avaliação assim passou e está publicada, é ela que vale a pena contestar.

## O que não é removido, mesmo parecendo injusto?

Crítica que segue a política fica no app. O iFood cita como válidas as críticas de sabor, quantidade e gosto pessoal. Também ficam:

- a nota baixa sem comentário;
- a reclamação de um problema que você acha que não aconteceu;
- a crítica dura, mas sem ofensa.

Pedir a remoção dessas avaliações gasta tempo e não muda a nota.

## Como pedir a revisão de uma avaliação irregular?

{{CONFERIR: o caminho atual no Portal do Parceiro para pedir que o iFood revise uma avaliação que fere a política (por exemplo, pelos chamados de ajuda) e o que o iFood pede para analisar.}}

Antes de abrir o pedido, junte:

1. O número do pedido e a data da avaliação.
2. O trecho do comentário que fere a política: a ofensa, o assunto de logística do iFood, o indício de fraude.
3. Prints do chat do pedido, se a conversa mostrar o que aconteceu.

Seja específico. Diga qual regra o comentário quebra, e não por que você discorda da nota.

## Qual o prazo para responder uma avaliação no iFood?

Pelas regras do iFood, o cliente tem 7 dias depois da compra para avaliar, e a loja tem 5 dias para responder. Depois de enviada, a resposta só pode ser editada por 10 minutos, então revise antes de mandar.

A resposta é pública: aparece para quem abre as avaliações da sua loja. Escreva pensando no próximo cliente, não só em quem reclamou.

## A resposta pode mudar a nota?

Pode. Quando a loja responde, o cliente recebe um aviso e tem a chance de rever a nota que deu. Por isso, responder rápido e bem rende mais do que contestar.

Uma boa resposta tem quatro partes:

1. **Agradeça pelo nome**, se o app mostrar.
2. **Reconheça o problema específico**, sem discutir: "o pedido chegou sem o molho".
3. **Diga o que mudou:** a conferência na saída, a conversa com a cozinha.
4. **Convide a pedir de novo**, sem prometer o que não pode cumprir.

Evite brigar, expor dados do pedido ou acusar o cliente de mentir. Quem mais lê a resposta é o próximo cliente.

> **Modelo de resposta para pedido com item faltando**
>
> Oi, Ana. Obrigado por contar. O pedido saiu sem o molho, e isso não pode acontecer. Já reforçamos a conferência dos pedidos antes da saída. Esperamos ter a chance de acertar no próximo.

## E a avaliação de 1 estrela sem comentário?

Não há o que contestar, porque não há texto que fira a política. Abra o pedido e olhe o horário, o tempo de despacho e os itens. Se houve atraso ou item faltando, trate a causa. Se não houve nada, ela entra na média dos 90 dias e se dilui com as próximas avaliações.

## Como evitar a próxima avaliação injusta?

A maioria das avaliações que parecem injustas tem uma causa real que a loja não viu: atraso no despacho, comida que esfriou esperando o entregador, item trocado. Comece pelo tempo: o artigo sobre [tempo de preparo x tempo de despacho](/blog/tempo-de-preparo-x-tempo-de-despacho) mostra como achar a espera escondida.

Depois, leia as avaliações por motivo, e não uma a uma, como explica o [guia da operação de delivery](/blog/operacao-de-delivery#avaliacoes-o-que-fazer-quando-a-nota-cai).

> **Na nossa operação**
>
> {{PREENCHER: quantas avaliações negativas uma das suas marcas respondeu num mês, quantas tiveram a nota revista pelo cliente e um exemplo de resposta que funcionou, sem dados do cliente.}}
`,
};
