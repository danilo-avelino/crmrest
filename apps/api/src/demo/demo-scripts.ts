import type { IfoodReviewDto, IfoodReviewsDto, MessageContent } from "@dishdesk/shared";
import { z } from "zod";

// Textos prontos da conta de demonstração: o que a IA "responderia" sem chamar a IA de verdade (regra da demo: nada sai do
// Dish Desk). Nomes e números são fictícios.

/** Sugestão de resposta (botão da Inbox) pela última mensagem do cliente. */
export function demoSuggestion(history: { direction: string; content: unknown }[], name: string | null): string {
  const last = [...history].reverse().find((message) => message.direction === "INBOUND");
  const text = ((last?.content as MessageContent | undefined)?.text ?? "").toLowerCase();
  const who = name?.split(" ")[0] ?? "";
  const hi = who ? `${who}, ` : "";
  if (/cad[eê]|demor|atras|n[aã]o chegou|previs/.test(text)) {
    return `${hi}sinto muito pela espera! Acabei de falar com a cozinha: seu pedido sai em instantes e eu te aviso assim que o entregador sair. 🙏`;
  }
  if (/fria|errad|faltando|faltou|veio sem|amassad/.test(text)) {
    return `${hi}peço desculpas, não era isso que a gente queria entregar. Já estamos preparando a correção sem custo nenhum para você, chega em até 30 minutos.`;
  }
  if (/pix|cart[aã]o|pagamento|pagar/.test(text)) return "Aceitamos Pix na entrega (maquininha), cartão de crédito, débito e dinheiro. 😊";
  if (/entreg|bairro|taxa/.test(text)) return `${hi}entregamos sim! A taxa vai de R$ 5 a R$ 9 conforme o bairro, e acima de R$ 120 a entrega é grátis. 🛵`;
  if (/hor[aá]rio|abert|fecha/.test(text)) return "Funcionamos todos os dias, das 10h à 1h da manhã. 🍕";
  return `Oi${who ? `, ${who}` : ""}! Obrigado por falar com a Vila Brasa. Como posso te ajudar? 😊`;
}

/** Avaliações do iFood de exemplo (a tela lê do iFood ao vivo; a loja da demo não existe lá). */
export function demoIfoodReviews(store: { id: string; tenantId: string; name: string }, from: Date, now: Date): IfoodReviewsDto {
  const day = 24 * 60 * 60 * 1000;
  const samples: [number, number, string | null, string, string, string[], string | null][] = [
    [0.1, 5, "Pizza chegou quentinha e muito saborosa! A Brasa da Casa é sensacional.", "Camila B.", "PUBLISHED", ["Sabor", "Entrega"], null],
    [0.4, 4, "Muito boa, só demorou um pouco mais que o previsto.", "Thiago R.", "REPLIED", ["Sabor"], "Obrigado, Thiago! Já ajustamos a cozinha para o horário de pico. Volte sempre!"],
    [0.9, 2, "A pizza veio fria e a borda sem recheio.", "Larissa M.", "NOT_REPLIED", ["Temperatura"], null],
    [1.6, 5, null, "Bruno S.", "PUBLISHED", [], null],
    [2.3, 5, "Melhor pizzaria da Vila Mariana, sem dúvida.", "Patrícia F.", "PUBLISHED", ["Sabor", "Embalagem"], null],
    [3.1, 3, "Gostei do sabor, mas veio faltando o refrigerante.", "Renato G.", "REPLIED", ["Itens do pedido"], "Renato, pedimos desculpas! Mandamos um cupom de cortesia pelo chat."],
    [4.2, 5, "Atendimento pelo WhatsApp super rápido, resolveram tudo.", "Aline C.", "PUBLISHED", ["Atendimento"], null],
    [5.5, 4, "Massa leve e bem assada.", "Gustavo P.", "PUBLISHED", ["Sabor"], null],
    [8.0, 5, "Sempre peço e nunca decepciona.", "Helena X.", "PUBLISHED", [], null],
    [12.0, 1, "Pedido cancelado sem aviso.", "Igor L.", "REPLIED", ["Entrega"], "Igor, o entregador não encontrou o endereço. Já corrigimos o mapa da sua região."],
    [19.0, 5, "Perfeita para a noite de futebol!", "Marcos T.", "PUBLISHED", ["Sabor"], null],
    [33.0, 4, "Boa pizza, preço justo.", "Débora N.", "PUBLISHED", [], null],
  ];
  const reviews: IfoodReviewDto[] = samples
    .map(([daysAgo, score, comment, customerName, status, answers, reply], i) => {
      const createdAt = new Date(now.getTime() - daysAgo * day);
      return {
        id: `demo-review-${i}`,
        tenantId: store.tenantId,
        storeId: store.id,
        storeName: store.name,
        score,
        comment,
        customerName,
        createdAt: createdAt.toISOString(),
        status,
        visibility: null,
        orderCode: String(4200 + i * 7),
        answers,
        replies: reply ? [{ text: reply, from: "MERCHANT", createdAt: new Date(createdAt.getTime() + 3 * 60 * 60 * 1000).toISOString() }] : [],
        replyBy: status === "NOT_REPLIED" ? new Date(createdAt.getTime() + 5 * day).toISOString() : null,
      };
    })
    .filter((review) => new Date(review.createdAt) >= from);
  return {
    stores: [{ id: store.id, name: store.name, score: 4.7, validReviews: 318, totalReviews: 342 }],
    unavailable: [],
    reviews,
  };
}

// ---------- Simulação ao vivo (botão escondido da demo) ----------

export const DEMO_SCENARIOS = ["cade_pedido", "novo_pedido", "reclamacao", "duvida", "entregador"] as const;
export type DemoScenario = (typeof DEMO_SCENARIOS)[number];
export const SimulateRequest = z.object({ scenario: z.enum(DEMO_SCENARIOS) });

/** Um passo do roteiro: quem fala, o texto e quantos segundos depois do passo anterior. */
export type DemoStep =
  | { after: number; kind: "customer"; text: string }
  | { after: number; kind: "ai"; text: string }
  | { after: number; kind: "handoff"; text: string }
  | { after: number; kind: "menu_agent"; text: string }
  | { after: number; kind: "automation"; automation: NonNullable<MessageContent["automation"]>; text: string };

/**
 * Roteiros: um cliente novo escreve e a "IA" responde no tempo de uma conversa de verdade. `name` e `courier` dizem quem
 * escreve; `order` pede um pedido do iFood novo, em preparo, ligado à conversa.
 */
export const DEMO_SCRIPTS: Record<DemoScenario, { label: string; name: string; courier?: boolean; order?: boolean; steps: DemoStep[] }> = {
  cade_pedido: {
    label: "Cliente perguntando do pedido",
    name: "Paula Menezes",
    order: true,
    steps: [
      { after: 0, kind: "customer", text: "Oi, boa noite! Meu pedido já saiu? Pedi faz uns 40 minutos" },
      { after: 4, kind: "ai", text: "Oi, Paula! Seu pedido está terminando de assar e sai para entrega em uns 5 minutos. A previsão é chegar até às {hora}. 🍕" },
      { after: 9, kind: "customer", text: "Ah que bom! Pode pedir pro motoboy tocar o interfone 32?" },
      { after: 4, kind: "ai", text: "Claro! Já deixei anotado para o entregador: interfone 32. 👍" },
      { after: 7, kind: "customer", text: "Obrigada!! 😊" },
    ],
  },
  novo_pedido: {
    label: "Pedido pela conversa (IA monta o carrinho)",
    name: "Rodrigo Tavares",
    steps: [
      { after: 0, kind: "customer", text: "Boa noite! Quero uma pizza grande de calabresa com borda de catupiry" },
      { after: 3, kind: "menu_agent", text: "Adicionou: Pizza Calabresa grande + Borda Catupiry" },
      { after: 1, kind: "ai", text: "Ótima escolha, Rodrigo! Calabresa grande com borda de Catupiry: R$ 69,90. Quer um refrigerante? O Guaraná 2 L sai por R$ 12." },
      { after: 8, kind: "customer", text: "Pode ser, manda um guaraná" },
      { after: 3, kind: "menu_agent", text: "Adicionou: Guaraná Antarctica 2 L" },
      { after: 1, kind: "ai", text: "Fechado! Total de R$ 81,90 + R$ 5,00 de entrega. Pagamento na entrega: dinheiro, cartão ou Pix na maquininha. Confirmo o pedido?" },
      { after: 8, kind: "customer", text: "Confirma! Vou pagar no cartão" },
      { after: 3, kind: "automation", automation: "menu_order_confirmed", text: "Pedido confirmado! 🎉 Já foi para a cozinha e chega em 35 a 55 minutos. Obrigado, Rodrigo!" },
    ],
  },
  reclamacao: {
    label: "Reclamação (IA chama a equipe)",
    name: "Sérgio Albuquerque",
    order: true,
    steps: [
      { after: 0, kind: "customer", text: "Pedi uma portuguesa e veio de frango. De novo isso" },
      { after: 4, kind: "ai", text: "Poxa, Sérgio, sinto muito pela troca! Vou chamar alguém da equipe agora para resolver isso com você." },
      { after: 1, kind: "handoff", text: "IA passou o atendimento para a equipe: problema no pedido" },
      { after: 10, kind: "customer", text: "Tô esperando, meus filhos não comem frango" },
    ],
  },
  duvida: {
    label: "Dúvida de cardápio (só a IA)",
    name: "Yasmin Correia",
    steps: [
      { after: 0, kind: "customer", text: "Oi! Vocês têm opção vegana?" },
      { after: 4, kind: "ai", text: "Oi, Yasmin! Temos a Margherita sem queijo, com tomate, manjericão e azeite, e ela pode ser meio a meio com a de legumes. 🌱" },
      { after: 9, kind: "customer", text: "E a massa leva ovo ou leite?" },
      { after: 4, kind: "ai", text: "A nossa massa é de fermentação natural, só farinha, água, sal e fermento: não leva ovo nem leite. 😊" },
      { after: 7, kind: "customer", text: "Perfeito, vou pedir pelo site então!" },
    ],
  },
  entregador: {
    label: "Entregador chegou no cliente",
    name: "Wanderson Lima",
    courier: true,
    order: true,
    steps: [
      { after: 0, kind: "customer", text: "cheguei no {pedido}" },
      { after: 3, kind: "automation", automation: "courier_arrival", text: "Avisamos o cliente que você chegou com o pedido #{pedido}. 👍" },
      { after: 6, kind: "automation", automation: "courier_arrival_confirmed", text: "Mensagem entregue ao cliente." },
    ],
  },
};
