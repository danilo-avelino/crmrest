import type { BlogPost } from "@/lib/blog/types";

export const despachoPost: BlogPost = {
  slug: "tempo-de-preparo-x-tempo-de-despacho",
  title: "Tempo de preparo x tempo de despacho: a diferença que derruba a nota",
  seoTitle: "Tempo de preparo x tempo de despacho no delivery",
  description:
    "Tempo de preparo vai até o pedido ficar pronto. Tempo de despacho vai até ele sair com o entregador. Veja como medir os dois e cortar a espera entre eles.",
  topic: "Tempo e logística",
  publishedAt: "2026-11-28",
  related: ["contestar-avaliacao-ifood", "operacao-de-delivery"],
  cta: {
    title: "Saiba quando cada pedido sai sem perguntar à cozinha",
    text: "O Dish Desk calcula a previsão de saída pelo tempo dos seus últimos pedidos e avisa quem já conversou com a loja quando o pedido fica pronto, sai para entrega ou atrasa.",
  },
  faq: [
    {
      question: "O tempo de preparo inclui embalar?",
      answer:
        "Deve incluir. O pedido só está pronto quando está embalado, conferido e pronto para ir para a mão do entregador.",
    },
    {
      question: "Devo colocar um tempo de preparo maior no app para não atrasar?",
      answer:
        "Só até o tempo real do pico. Tempo maior que o real deixa o pedido pronto esperando e, segundo a 99Food, pode afastar clientes. Ajuste pelo horário, não por margem de segurança.",
    },
    {
      question: "Qual a diferença entre tempo de despacho e tempo de entrega?",
      answer:
        "O despacho termina quando o pedido sai da loja. A entrega termina quando ele chega ao cliente e inclui o trajeto, que depende da distância e do entregador.",
    },
  ],
  body: `
Tempo de preparo é o tempo do aceite até o pedido ficar pronto e embalado. Tempo de despacho é o tempo do aceite até o pedido sair da loja na mão do entregador. A diferença entre os dois é espera, e é nela que o pedido esfria, atrasa e vira avaliação ruim.

Quase todo restaurante mede o primeiro e chama de "tempo do pedido". O cliente só sente o segundo.

## Qual a diferença entre tempo de preparo e tempo de despacho?

- **Tempo de preparo:** do aceite até o pedido pronto, embalado e conferido.
- **Tempo de despacho:** do aceite até o pedido sair da loja com o entregador.
- **Espera no balcão:** a diferença entre os dois. Pode ser o pedido esperando o entregador ou o entregador esperando o pedido.

Por exemplo: uma cozinha que prepara em 15 minutos e despacha em 28 tem 13 minutos de espera que não aparecem em nenhum relatório de cozinha.

## Por que essa diferença derruba a nota?

Porque cada lado da espera estraga o pedido de um jeito:

- **Pedido pronto esperando o entregador:** a batata murcha, o molho separa, o prato quente esfria. O cliente reclama da comida, e a loja procura o problema na cozinha.
- **Entregador esperando o pedido:** a entrega atrasa e o entregador perde a corrida seguinte. No pico, a fila no balcão vira atraso em cadeia.

Nos dois casos a avaliação diz "chegou frio" ou "demorou", e a causa está no intervalo que ninguém mede.

## Como o app usa o tempo de preparo que eu configuro?

O tempo médio de preparo que você informa entra no prazo de entrega que o cliente vê. A 99Food diz isso no [guia de configuração do tempo de preparo](https://99app.com/99food/restaurantes/guias/como-configurar-o-tempo-de-preparo/): tempo menor que o real causa atraso, avaliação negativa e cancelamento, e tempo maior afasta clientes.

Por isso o número configurado tem que ser o tempo real no horário em que você mais vende, e não o de um pedido feito com a cozinha vazia. A 99Food também deixa cadastrar um tempo especial para os dias e horários de mais movimento.

## Como medir os dois tempos na prática?

Anote quatro horários de cada pedido durante uma semana:

1. **Aceite:** quando o pedido entrou na cozinha.
2. **Pronto:** quando foi embalado e conferido.
3. **Saída:** quando saiu da loja com o entregador.
4. **Entrega:** quando chegou ao cliente.

Preparo é pronto menos aceite. Despacho é saída menos aceite. Espera é saída menos pronto.

Olhe a mediana e os 10% piores pedidos de cada turno, não a média do dia. A média esconde o pico, e é no pico que a nota cai.

> **Na nossa operação**
>
> {{PREENCHER: o tempo de preparo e o tempo de despacho medianos de uma das suas marcas no almoço e no jantar, a espera entre eles e o que mudou nas avaliações depois do ajuste.}}

## Quanto de espera é aceitável?

O mínimo possível, nos dois sentidos, e o limite depende do cardápio. Fritura e prato gratinado perdem textura em poucos minutos parados. Um entregador esperando no balcão com frequência é sinal de que o tempo configurado está curto.

Teste quanto tempo cada prato aguenta pronto sem perder qualidade e use esse limite como meta de espera da loja.

## Como diminuir a espera entre o pronto e a saída?

- **Ajuste o tempo configurado pelo pico.** Se o entregador espera, o tempo está curto. Se o pedido espera, pode estar longo.
- **Comece pelo item mais lento.** Num pedido com vários itens, o mais demorado define o pronto. Escalone o início para os itens terminarem juntos.
- **Monte o pedido perto da saída.** Pedido pronto guardado longe do balcão é tempo perdido procurando o pacote certo.
- **Confira antes de chamar.** Item faltando descoberto na hora da saída vira volta para a cozinha.
- **Separe o problema do pico.** Se a espera só aparece num turno, o problema é capacidade naquele turno, não o processo inteiro.
- **Use o aumento pontual com cuidado.** Na 99Food dá para aumentar o tempo de preparo de um pedido uma única vez, o entregador vê a mudança e ela não pode ser desfeita, segundo o [guia da plataforma](https://99app.com/99food/restaurantes/guias/como-aumentar-o-tempo-de-preparo-do-pedido/).

## Como avisar o cliente de um atraso?

Avise antes de ele perguntar. Uma mensagem dizendo que o pedido saiu, ou que vai atrasar alguns minutos, evita o "cadê meu pedido?" e deixa o cliente menos irritado quando a comida chega. Respostas prontas para atraso fazem parte do [atendimento em vários canais](/blog/operacao-de-delivery#atendimento-como-nao-perder-mensagem-em-varios-canais).

Se a nota já caiu por atraso, veja [o que fazer com uma avaliação injusta no iFood](/blog/contestar-avaliacao-ifood).
`,
};
