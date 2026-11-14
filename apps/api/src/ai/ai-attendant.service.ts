import type { TenantTx } from "@dishdesk/database";
import type { ChannelType, OrderStatus } from "@dishdesk/database/enums";
import {
  automationMessagesOf,
  businessHoursOf,
  CHANNEL_CAPABILITIES,
  CHANNEL_LABEL,
  COURIER_TAG,
  fillMessage,
  type MessageContent,
  orderLinksOf,
} from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import { z } from "zod";
import {
  type AutomationState,
  automationMessage,
  callTeam,
  dispatch,
  firstName,
  setAutomationState,
  startOfYesterday,
  systemEvent,
} from "../automations/automation.js";
import { linkOrderContact, ORDER_STATUS_TEXT, TriageService } from "../automations/triage.service.js";
import { ifoodChatOrderOf } from "../conversations/ifood-conversation.js";
import { DatabaseService } from "../core/database.service.js";
import { JevClient } from "../defense/jev.client.js";
import { orderUpdateMessage } from "../orders/forecast.js";
import { latestOrderOf } from "../orders/latest-order.js";
import { withOrderTenants } from "../orders/order-scope.js";
import { type AiJob, type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { PresenceService } from "../realtime/presence.service.js";
import { type Attendance, attendanceOf } from "./ai-forward.service.js";
import { LlmClient, type LlmMessage } from "./llm.client.js";
import { REPLY_STYLE, restaurantFacts, toneOf, transcript, WRITING_RULES } from "./prompts.js";

/** Respostas da IA num atendimento; na seguinte, ela passa para a equipe sem perguntar à LLM. */
export const MAX_AI_REPLIES = 8;
/** Mensagens da conversa (das últimas 12 horas) que a IA lê antes de responder. */
const HISTORY_LIMIT = 30;
const HISTORY_MS = 12 * 60 * 60 * 1000;
/** A mensagem pronta do Cardápio Web ("...sobre meu pedido de número *0058* feito hoje às 12:19"). */
const CARDAPIO_WEB_ASK = /pedido\s+de\s+n[uú]mero\s*\*?#?\s*\d{1,6}/i;
/** Quanto a IA espera o pedido citado nessa mensagem chegar pela integração. */
export const ORDER_ARRIVAL_WAIT_MS = 20_000;
/** Resposta da equipe na conversa há menos que isto: ela ainda está atendendo, mesmo depois do horário. */
const TEAM_ACTIVE_MS = 15 * 60_000;

/** Alguém da equipe (pelo painel ou pelo celular da loja) respondeu na conversa depois de `since`. */
export function teamRepliedSince(history: { direction: string; content: unknown; sentByUserId: string | null; createdAt: Date }[], since: number): boolean {
  return history.some(
    (message) => message.direction === "OUTBOUND" && (!!message.sentByUserId || !!(message.content as MessageContent).fromPhone) && message.createdAt.getTime() >= since,
  );
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const BRASILIA_TIME = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export const AttendantReply = z.object({
  // Sem .min(1): com skip = true a LLM às vezes manda reply vazio, e a resposta inteira era recusada (13/11/2026: o
  // robô de dedetização recebeu o aviso de fora do horário do menu). Vazio sem skip é conferido depois.
  reply: z.string().trim().max(1000).describe("A mensagem para o cliente."),
  handoff: z.boolean().describe("true = passar o atendimento para a equipe."),
  // Sem .max(): o SDK do Claude tira o limite do schema e o confere depois, e um motivo comprido derrubava a resposta
  // inteira (o cliente recebia o menu). O texto é cortado onde é usado.
  reason: z.string().describe("Para a equipe, em até 200 caracteres: por que passou o atendimento. Vazio quando handoff = false."),
  order: z
    .enum(["confirmed", "denied", "none"])
    .describe(
      'Resposta do cliente à sua pergunta "é esse o seu pedido?": "confirmed" = ele respondeu que sim; "denied" = respondeu que não; "none" = você ainda não perguntou ou ele não respondeu a isso. Informar o número do pedido não é confirmar.',
    ),
  // Sem ela, a IA respondia a cada "obrigado" de um robô de vendas até chamar a equipe (12/11/2026).
  skip: z.boolean().default(false).describe('true = não mandar nenhuma mensagem (só nos casos de "Não responda").'),
  // A equipe confirma no modal da conversa e, se for, o cadastro ganha a tag Entregador (pedido do usuário, 14/11/2026).
  courier: z.boolean().default(false).describe("true = quem escreve parece ser um entregador, e não um cliente."),
});
type AttendantReply = z.infer<typeof AttendantReply>;

export function systemPrompt(restaurant: string, channel: ChannelType, settings: unknown): string {
  // No iFood o telefone é pedido só para o atendimento: cupom pede opt-in de marketing, e o iFood restringe a loja que
  // leva o cliente para fora da plataforma.
  const phoneAsk =
    channel === "IFOOD"
      ? 'diga que é para a equipe conseguir falar com ele se a conversa cair (ex.: "Alguém da equipe vai continuar por aqui. Enquanto isso, quer deixar seu telefone com DDD, caso a conversa caia?"). Não fale em cupom nem em WhatsApp'
      : 'sem problema com o pedido, diga que é para receber cupons pelo WhatsApp (ex.: "Vou chamar um atendente. Enquanto isso, quer deixar seu telefone com DDD para receber cupons pelo WhatsApp?"); com problema, diga que é para a equipe poder falar com ele';
  return `Você é o atendente virtual do restaurante ${restaurant} e responde clientes pelo ${CHANNEL_LABEL[channel]}.
${toneOf(settings)}
${WRITING_RULES}
${REPLY_STYLE}

Você tira dúvidas sobre o horário de funcionamento, os links para fazer pedido e o andamento do pedido do cliente, usando só os DADOS.

Como ler a CONVERSA: "Restaurante (IA)" é você. "Restaurante (atendente)" e "Restaurante (loja)" são a equipe do restaurante. "Restaurante (automação)" são avisos automáticos (status do pedido, aviso de que o entregador chegou).

Regras obrigatórias:
- Só afirme o que está nos DADOS. Nunca invente preço, cardápio, prazo, taxa, promoção, endereço ou política, nem a causa de um problema (ex.: "deve ser instabilidade no link").
- Você não anota pedidos: para pedir, mande os links (se houver); sem links, passe para a equipe.
- Você não altera pedido e não passa recado ao entregador nem à cozinha: nunca diga "anotado", "vou avisar", "já registrei" ou outra frase que prometa isso. Quem faz é a equipe.
- Você não fala pelo restaurante sobre o que não é atendimento ao cliente: não aceite nem recuse proposta, parceria, vaga ou fornecedor.
- Cumprimente só na sua primeira resposta do atendimento, como diz "Cumprimento" nos DADOS; depois, vá direto ao ponto.

Quando o cliente quiser saber do andamento de um pedido (se saiu, se chegou, onde está, atraso), siga estes passos:
1. Há nos DADOS um pedido ainda não confirmado: mostre o número, os itens e o total e pergunte se é esse o pedido dele. Não diga o andamento antes de ele confirmar.
2. Ele confirmou (order = "confirmed") ou os DADOS dizem que o pedido é o deste chat: diga o andamento que está nos DADOS, sem perguntar se o pedido é dele e sem repetir os itens e o total.
3. Ele disse que não é (order = "denied") ou não há pedido nos DADOS: peça o número do pedido (e o telefone usado no pedido, se os DADOS disserem que o telefone não está no cadastro), sem passar para a equipe. Não diga que não achou o pedido nem fale em cadastro: só peça o número.
4. Ele informou o número (e o telefone, se você pediu) e o pedido continua fora dos DADOS: passe para a equipe.
Os passos valem só para o andamento. Problema, mudança ou cancelamento vão direto para a equipe, sem você pedir antes que ele confirme o pedido.

Passe para a equipe (handoff = true) só quando o cliente:
- pedir para falar com uma pessoa ou atendente, ou responder que sim quando você perguntar se ele quer;
- contar um problema com o pedido (item errado ou faltando, qualidade, entrega) ou pedir cancelamento, reembolso ou troca;
- pedir uma mudança no pedido (observação, item, endereço, trocar retirada por entrega) ou um recado para o entregador ou para a cozinha (buzinar, interfonar, deixar na portaria, esperar ele descer, uma referência para achar o endereço, como a cor da casa ou do portão);
- disser que está no local e não encontra o entregador, ou que ninguém apareceu, depois do aviso de que o entregador chegou;
- continuar reclamando do atraso depois que você disse o andamento do pedido;
- perguntar ou falar sobre pagamento (Pix, chave Pix, se o pagamento foi confirmado, comprovante, formas de pagamento, vale-refeição, maquininha, troco, cobrança): passe direto, sem perguntar se ele quer um atendente. Diga só que está chamando alguém da equipe para cuidar disso (ex.: "Vou chamar alguém da equipe para cuidar do seu pagamento."). Não diga se você vê ou não o pagamento, se tem ou não a informação, nem o que você consegue ou não consegue fazer;
- perguntar sobre o restaurante algo que não está nos DADOS nem no cardápio (entrega, taxa, endereço, promoção);
- disser que não consegue abrir o link ou terminar o pedido por ele;
- responder a uma pergunta que a equipe fez (a última mensagem do restaurante na CONVERSA é de atendente ou da loja e pergunta algo): a resposta é para a equipe. Diga só que a equipe já vai ver, sem dizer que não entendeu;
- parecer ser um entregador, e não um cliente (pede para avisar o cliente de um pedido, diz que chegou ou que está na porta com o pedido): diga que alguém da equipe já vai falar com ele e escreva no reason que parece ser um entregador sem a tag Entregador e responda com courier = true;
- mandar imagem, vídeo ou documento: pode ser a foto de um problema ou um comprovante de pagamento, que só a equipe consegue ver. Diga só que alguém da equipe vai ver; não peça para ele descrever.

Não passe para a equipe (handoff = false):
- Reclamação de atraso: siga os passos do pedido (mostre o pedido, diga o andamento ou peça o número). A equipe só entra no passo 4 ou se o cliente continuar reclamando depois do andamento.
- Pedido de acompanhamento (quer acompanhar, ver a localização do entregador, ser avisado quando ele chegar ou quando o pedido sair): diga que você não sabe a localização do entregador nem quando ele chega, e que o próprio entregador consegue avisar quando chegar. Não diga que o cliente consegue falar com o entregador nem peça que ele avise o entregador: você não sabe se há esse contato. Se o pedido ainda não foi entregue nem cancelado (veja o status e o andamento nos DADOS), diga que vai enviar aqui as atualizações que ainda faltam: quando ficar pronto, quando sair para entrega e quando for entregue (o pedido que já saiu, só quando for entregue). Esses avisos saem sozinhos: não diga que não consegue avisar quando o pedido ficar pronto ou sair.
- Depois do aviso de que o entregador chegou ou deixou o pedido na portaria, o cliente só responde ("ok", "certo", "descendo", "indo pegar", "avisei a portaria", "já recebi"): uma frase curta, sem repetir o andamento e sem passar para a equipe. O aviso vale mais que o status dos DADOS: não diga que o entregador está a caminho nem que deve chegar.
- O pedido está cancelado nos DADOS e o cliente só avisa que não vai receber ou que cancelou: diga que o pedido já consta como cancelado e que ele não precisa fazer mais nada, sem pedir o telefone. Se ele pedir reembolso ou reclamar, aí sim passe para a equipe.
- O pedido está cancelado nos DADOS e o cliente pergunta por ele (não sabia do cancelamento): diga que ele consta como cancelado e, se os DADOS trazem o motivo, qual foi, com as palavras da loja. Sem o motivo nos DADOS, ou se ele diz que não cancelou, passe para a equipe. Não comente se a notícia é boa ou ruim.
- O cliente diz que já resolveu ou que já recebeu: despeça-se em poucas palavras.
- Cardápio, sabores, opções (vegana, sem glúten...) ou preço, mesmo de um item ou combo específico: você não sabe nenhum preço. Escreva na mensagem os links para fazer pedido, com o endereço completo como está nos DADOS, diga que lá estão o cardápio e os preços e pergunte se ele quer que você chame um atendente, com handoff = false. Se os links já estão na CONVERSA, não mande de novo: diga que os preços estão nos links que você mandou e faça a mesma pergunta. Sem links, passe para a equipe.
- Áudio: diga que não consegue ouvir áudios e peça para ele escrever. Se ele mandar outro áudio, passe para a equipe. Só fale de um áudio ou de uma imagem se for a mensagem mais recente do cliente: se ele já escreveu outra coisa depois, responda ao que ele escreveu.
- "Mensagem de um tipo que o Dish Desk ainda não exibe": o cliente mandou algo que você não consegue ver (enquete, contato, botão). Peça para ele escrever o que precisa.
- Mensagem sem relação com pedido ou com o restaurante (conversa solta, brincadeira, frase sem sentido): responda em poucas palavras, como uma pessoa responderia, e puxe o assunto do restaurante numa frase, sem listar tudo o que você sabe fazer. Depois, espere o cliente.
- Divulgação, oferta de serviço, proposta de parceria, fornecedor ou robô de outra empresa: responda uma vez só, numa frase, que este canal é para o atendimento dos clientes do restaurante, sem dizer se o restaurante tem interesse. Depois disso, não responda mais (skip = true).
- O cliente agradeceu ou se despediu: despeça-se em poucas palavras, sem fazer nova pergunta.
- Você não entendeu o que o cliente quer: pergunte o que ele precisa, numa frase curta, e espere a resposta.
- Na CONVERSA, a sua última mensagem já perguntou como ajudar e o cliente respondeu sem dizer o que quer: não repita a pergunta; pergunte se ele quer falar com um atendente, com handoff = false, e espere ele responder que sim. Se ele só cumprimentou de novo ("boa tarde", "oi"), não responda (skip = true): ele ainda está escrevendo.
- Você já avisou neste atendimento que o restaurante está fechado ou sem atendentes e quando volta: não repita o aviso a cada resposta.

Não responda (skip = true, com "-" em reply e handoff = false) só nestes casos. Na dúvida, responda.
- O cliente só agradeceu, confirmou ("ok", "certo", "obrigada") ou se despediu, e você já se despediu ou já respondeu a isso neste atendimento.
- A equipe já respondeu ao cliente neste atendimento e ele só agradeceu ou confirmou para ela.
- O cliente só cumprimentou de novo, logo depois de você perguntar em que pode ajudar.
- Divulgação, corrente, lista de transmissão, oferta de serviço ou robô de outra empresa: depois da sua única resposta, ou já na primeira mensagem quando é claramente um envio em massa que não pede nada.

Mensagem de quando você passa para a equipe (handoff = true):
- Reclamação ou problema (não uma simples pergunta): comece reconhecendo o problema que o cliente contou, com as palavras do caso (ex.: "Sinto muito pela demora do seu pedido"), e não com uma frase genérica ("Lamentamos o transtorno"). Não prometa solução, reembolso nem desconto.
- Há atendente online (veja "Atendentes" nos DADOS): diga que alguém da equipe vai continuar o atendimento, sem fazer nenhuma pergunta (quem continua é a equipe). Não diga "um momento" nem que você vai verificar: quem verifica é a equipe.
- A equipe já respondeu ao cliente neste atendimento (há "Restaurante (atendente)" ou "Restaurante (loja)" na CONVERSA depois da primeira mensagem dele): não anuncie de novo que alguém vai continuar. Diga só, numa frase, que a equipe já vai ver o que ele acabou de mandar.
- Exceção, só quando os DADOS dizem que o telefone do cliente não está no cadastro: no fim da mensagem, aproveite a espera e pergunte se ele quer deixar o telefone com DDD: ${phoneAsk}. Essa é a única pergunta permitida.
- Não há atendente: siga o que "Atendentes" diz nos DADOS e continue respondendo as outras dúvidas do cliente.`;
}

// "1234", "#1234", "é o 1234", "pedido 1234", "Pedido Nº 1234", "pedido: 1234", "número do pedido é 1234". Números
// soltos no meio do texto ("2 pizzas", "há 30 minutos") não contam: achariam o pedido de outro cliente.
const ORDER_NUMBER = [
  /^\s*(?:[ée]\s+(?:o\s+)?|o\s+)?(?:pedido\s*)?(?:n[º°]\.?\s*|n[uú]mero\s*)?#?\s*(\d{1,6})\s*[.!]?\s*$/gi,
  /pedido\s*(?:n[º°]\.?|n\.|n[uú]mero|#|:)\s*#?\s*(\d{1,6})(?!\d)/gi,
  // A mensagem pronta do Cardápio Web: "informações sobre meu pedido de número *0098* feito hoje às 18:26".
  /pedido\s+de\s+n[uú]mero\s*\*?#?\s*(\d{1,6})(?!\d)/gi,
  /n[uú]mero\s+do\s+pedido\s*(?:é|e|:)?\s*#?\s*(\d{1,6})(?!\d)/gi,
  // "pedido 1234 já saiu?": o número seguido do fim da frase ou de um verbo, não de uma medida ("pedido 30 minutos atrás").
  /pedido\s+#?\s*(\d{1,6})(?=\s*$|\s*[?!.,;]|\s+(?:j[áa]|que|foi|est[áa]|t[áa]|ainda|n[ãa]o|saiu|chegou|vai|vem|e)(?![a-zà-ú]))/gi,
];

/** Números de pedido que o cliente informou nas mensagens (com e sem os zeros à esquerda). */
export function orderNumbersIn(texts: string[]): string[] {
  const numbers = texts.flatMap((text) => ORDER_NUMBER.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]!)));
  return [...new Set(numbers.flatMap((number) => [number, number.replace(/^0+(?=\d)/, "")]))];
}

/**
 * Pedido de hoje ou de ontem com o número que o cliente informou na conversa; com dois pedidos possíveis, nenhum.
 * Qualquer pedido com o número, mesmo de outro cadastro: decisão do produto (31/10/2026), contra o achado da auditoria
 * de segurança de 30/10. Por isso confirmar um pedido achado assim não une os cadastros (ver confirmOrder).
 * `exclude`: pedidos que o cliente já disse não serem dele.
 */
async function orderByNumber(orders: TenantTx, history: { direction: string; content: unknown }[], now: Date, exclude: string[]) {
  const codes = orderNumbersIn(history.filter((m) => m.direction === "INBOUND").map((m) => (m.content as MessageContent).text ?? ""));
  if (!codes.length) return null;
  const found = await orders.order.findMany({
    where: { displayCode: { in: codes }, placedAt: { gte: startOfYesterday(now) }, id: { notIn: exclude } },
    include: { items: true },
    orderBy: { placedAt: "desc" },
    take: 2,
  });
  return found.length === 1 ? found[0]! : null;
}

/** Número de pedido citado na resposta que não é `code` (o pedido do chat do iFood), com ou sem os zeros à esquerda. */
export function otherOrderNumber(reply: string, code: string): string | null {
  const plain = (number: string) => number.replace(/^0+(?=\d)/, "");
  for (const match of reply.matchAll(/(?:#\s*|pedido\s+(?:n[º°.]?\s*)?)(\d{3,6})(?!\d)/gi)) {
    if (plain(match[1]!) !== plain(code)) return match[1]!;
  }
  return null;
}

export type OrderFacts = {
  displayCode: string | null;
  externalOrderId: string;
  channelType: ChannelType;
  placedAt: Date;
  status: OrderStatus;
  items: { quantity: number; name: string }[];
  total: { toString(): string };
  update: { text: string } | null;
  /** O cliente confirmou neste atendimento que o pedido é dele. */
  confirmed: boolean;
  /** Achado pelo número que o cliente informou (não pelo cadastro). */
  byNumber: boolean;
  /** O pedido do próprio chat (iFood): o cliente já está identificado por ele, sem confirmação. */
  chatOrder?: boolean;
  /** O motivo que a loja deu ao cancelar ("Pedido fora da área de entrega"). */
  cancellationReason?: string | null;
};

/** O que a LLM recebe para responder: as regras e, na mensagem do usuário, os DADOS e a CONVERSA. */
export function attendantMessages(
  restaurant: string,
  channel: ChannelType,
  settings: unknown,
  now: Date,
  orderFacts: string,
  conversation: string,
  attendance: Attendance,
  greeting: { first: boolean; name?: string; reopened?: boolean },
): LlmMessage[] {
  const facts = [restaurantFacts(restaurant, settings, now), greetingFacts(greeting, now), attendanceFacts(attendance), orderFacts].join("\n");
  return [
    { role: "system", content: systemPrompt(restaurant, channel, settings) },
    { role: "user", content: `DADOS\n${facts}\n\nCONVERSA\n${conversation}` },
  ];
}

const BRASILIA_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hourCycle: "h23" });

/** "Bom dia", "Boa tarde" ou "Boa noite" no horário de Brasília. */
export function periodGreeting(now: Date): string {
  const hour = Number(BRASILIA_HOUR.format(now));
  return hour >= 5 && hour < 12 ? "Bom dia" : hour >= 12 && hour < 18 ? "Boa tarde" : "Boa noite";
}

/**
 * Como começar a resposta. Na primeira do atendimento, o cumprimento do horário com o nome e a pergunta de como ajudar
 * (sem ela, a IA abria uma conversa nova mostrando o pedido de ontem); a instrução vai no dado, que o modelo segue melhor.
 */
function greetingFacts(greeting: { first: boolean; name?: string; reopened?: boolean }, now: Date): string {
  if (!greeting.first) return "Cumprimento: você já cumprimentou o cliente neste atendimento; não cumprimente de novo.";
  const hello = `${periodGreeting(now)}${greeting.name ? `, ${greeting.name}` : ""}!`;
  // Cliente respondendo ao último recado da equipe numa conversa já resolvida (13/11: "Boa noite" depois do "Ok" do
  // atendente reabria a conversa e a IA cumprimentava de novo).
  const reopened = greeting.reopened
    ? 'Retomada: a conversa já tinha sido atendida e resolvida, e o cliente voltou a escrever. Se ele só cumprimentou, agradeceu, confirmou ("ok", "boa noite", "obrigado") ou repetiu o que já tinha dito e a equipe ou você já respondeu, não responda (skip = true): a conversa continua resolvida. Se ele pediu algo novo, responda normalmente.\n'
    : "";
  return `${reopened}Cumprimento: esta é a sua primeira resposta neste atendimento. Comece com "${hello}" (pode ajustar ao tom do restaurante, mantendo o período do dia${greeting.name ? " e o nome; o nome vem do perfil do cliente e, se não for nome de pessoa (empresa, frase, apelido de grupo), cumprimente sem ele" : ""}). Se o cliente ainda não disse o que precisa (só cumprimentou, mandou um teste ou algo solto), pergunte em que pode ajudar e não fale de pedido nenhum. Se ele já disse, responda logo depois do cumprimento.`;
}

/**
 * Se há atendente para continuar o atendimento. Sem: a IA atende sozinha e, quando o cliente precisa da equipe, avisa
 * que não há atendentes e que a conversa vai para um assim que houver (a instrução vai no próprio dado: o modelo a
 * segue melhor que uma regra condicional no prompt).
 */
function attendanceFacts(attendance: Attendance): string {
  if (attendance.available) return "Atendentes: há alguém da equipe online para continuar o atendimento.";
  const when =
    attendance.reason === "closed"
      ? `nenhum agora, porque o restaurante está fechado. Quando o cliente precisar da equipe (handoff = true), diga que no momento estamos sem atendentes, que o restaurante volta a atender ${attendance.reopening} e que a conversa será encaminhada para a equipe assim que abrir.`
      : "nenhum online agora. Quando o cliente precisar da equipe (handoff = true), diga que no momento estamos sem atendentes online e que, assim que um chegar, a conversa será encaminhada para ele.";
  // Sem atendente, a regra de passar toda reclamação para a equipe faria a IA avisar logo de cara que não há ninguém.
  return `Atendentes: ${when} Você continua atendendo sozinho: tente resolver com os DADOS antes de falar da equipe. Só fale que não há atendentes (handoff = true) quando o cliente pedir para falar com uma pessoa ou quando você não conseguir resolver (ex.: item errado, pagamento, cancelamento, reembolso, algo fora dos DADOS). Num atraso, diga o andamento do pedido e passe para a equipe só se o cliente continuar insatisfeito ou pedir cancelamento, reembolso ou troca. Não diga que alguém vai falar com ele agora.`;
}

/**
 * O pedido nos DADOS do atendimento. Sem pedido, o que fazer vai junto: o modelo segue melhor uma instrução nos DADOS,
 * e sem ela ele passava para a equipe sem pedir o número ou contava ao cliente que não achou nada "no cadastro".
 */
export function attendantOrderFacts(order: OrderFacts | null, noPhone: boolean): string {
  const facts = orderFactsOf(order, noPhone);
  // Com pedido nos DADOS, o telefone ausente não consta de orderFactsOf.
  const phoneNote = order && noPhone ? "\nO telefone do cliente não está no cadastro." : "";
  if (order?.confirmed) return `${facts}${phoneNote}`;
  if (order) return `${facts}${phoneNote}\nSó fale deste pedido se o cliente falar de um pedido (atraso, andamento, problema): se ele não falou, não cite o pedido.`;
  return `${facts} Se o cliente falar de um pedido (atraso, andamento), peça o número do pedido, sem dizer que não achou o pedido nem falar em cadastro: o pedido com o número que ele informar aparece aqui nos DADOS. Se ele já informou o número e o pedido continua fora dos DADOS, passe para a equipe (handoff = true), que vai conferir.`;
}

/**
 * A previsão e a fila andam com a cozinha. Sem esta regra, a IA chamava a atualização de "correção" ("e não 21:25 como
 * eu falei antes", "o correto são 3") e a puxava sozinha depois de um "obrigada".
 */
const ANDAMENTO_RULE =
  'A previsão e a fila mudam conforme a cozinha anda. Se mudaram desde o que você já disse na CONVERSA, diga que é a atualização de agora ("agora a previsão é..."), sem chamar de correção nem dizer que errou. Depois de dizer o andamento, só fale dele de novo se o cliente perguntar.';

/** O pedido do cliente nos DADOS da IA: o confirmado, o candidato a confirmar (sem o andamento liberado) ou nenhum. */
export function orderFactsOf(order: OrderFacts | null, noPhone: boolean): string {
  if (!order) {
    return `Pedido do cliente: nenhum pedido de hoje ou de ontem no cadastro nem com um número informado na conversa.${noPhone ? " O telefone do cliente não está no cadastro." : ""}`;
  }
  const source = order.byNumber ? "achado pelo número que ele informou" : "ligado ao cadastro dele";
  return [
    order.chatOrder
      ? "Pedido do cliente (é o pedido deste chat do iFood: não pergunte se é dele):"
      : order.confirmed
        ? "Pedido do cliente (ele confirmou que é dele):"
        : `Pedido que pode ser do cliente (${source}; ainda não confirmado por ele):`,
    `#${order.displayCode ?? order.externalOrderId} (${CHANNEL_LABEL[order.channelType]}), feito em ${BRASILIA_TIME.format(order.placedAt)}, ${ORDER_STATUS_TEXT[order.status]}.${order.status === "CANCELED" && order.cancellationReason ? ` Motivo do cancelamento, dado pela loja: ${order.cancellationReason}.` : ""}`,
    `Itens: ${order.items.map((item) => `${item.quantity}x ${item.name}`).join("; ")}. Total: ${BRL.format(Number(order.total))}.`,
    ...(order.chatOrder
      ? [
          `Este chat é só do pedido #${order.displayCode ?? order.externalOrderId}, e o número não muda: não peça o número do pedido e não fale de nenhum outro número, mesmo que o cliente cite outro. Se ele perguntar de outro pedido, diga que este chat é do pedido #${order.displayCode ?? order.externalOrderId} e que, sobre outro pedido, ele precisa escrever no chat daquele pedido no iFood.`,
        ]
      : []),
    ...(order.update ? [`Andamento agora${order.confirmed ? "" : " (só diga depois que ele confirmar que o pedido é dele)"}: ${order.update.text}`, ANDAMENTO_RULE] : []),
  ].join("\n");
}

/**
 * Atendimento com IA (E27): no lugar do menu de atendimento, a LLM responde o cliente com os dados do restaurante e
 * passa para a equipe quando não pode resolver. O TriageService decide se a IA atende e agenda o job "reply" da fila ai.
 * Sem resposta da principal nem da reserva, o atendimento segue no menu (o último fallback).
 */
@Injectable()
export class AiAttendantService {
  private readonly logger = new Logger(AiAttendantService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
    @InjectQueue(QUEUES.ai) private readonly ai: Queue<AiJob>,
    private readonly llm: LlmClient,
    private readonly presence: PresenceService,
    private readonly triage: TriageService,
    private readonly jev: JevClient,
  ) {}

  /** Responde à última mensagem do cliente, se ninguém respondeu ainda (mensagens seguidas recebem uma resposta só). */
  async reply(tenantId: string, conversationId: string, now = new Date()): Promise<void> {
    const scope = { tenantIds: [tenantId] };
    const context = await this.db.withTenants(scope, async (tx) => {
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: {
          id: true,
          tenantId: true,
          channelId: true,
          automationState: true,
          contact: true,
          channel: { select: { type: true } },
          tenant: { select: { name: true, settings: true } },
        },
      });
      if ((conversation.automationState as AutomationState).ai !== "on") return null;
      const recent = (
        await tx.message.findMany({
          where: { conversationId, direction: { in: ["INBOUND", "OUTBOUND"] }, createdAt: { gte: new Date(now.getTime() - HISTORY_MS) } },
          orderBy: { createdAt: "desc" },
          take: HISTORY_LIMIT,
        })
      ).reverse();
      const last = recent.at(-1);
      if (last?.direction !== "INBOUND") return null; // já respondida: por outro job, pela equipe ou por uma automação
      // No iFood o chat é de um pedido só: o da mensagem do cliente. A conversa da Inbox junta os chats de todos os pedidos
      // dele na loja, mas a IA lê só este, como o cliente o vê.
      const chat = conversation.channel.type === "IFOOD" ? ifoodChatOrderOf(last.externalMessageId) : null;
      const history = chat
        ? recent.filter((message) => [null, chat].includes(ifoodChatOrderOf(message.externalMessageId)))
        : recent;
      const settings = conversation.tenant.settings;
      const state = conversation.automationState as AutomationState;
      const denied = state.aiDeniedOrderIds ?? [];
      // O pedido que o cliente confirmou neste atendimento; senão, o candidato a confirmar: o do cadastro ou o do número informado.
      const order = await withOrderTenants(this.db, tx, conversation.channelId, async (orders) => {
        // No iFood, o pedido do chat e nenhum outro: nem o do cadastro, nem um número que o cliente cite (13/11: a IA
        // "corrigia" o #0028 para o #8270, os dois do mesmo cliente).
        if (chat) {
          const found = await orders.order.findUnique({
            where: { channelId_externalOrderId: { channelId: conversation.channelId, externalOrderId: chat } },
            include: { items: true },
          });
          if (!found) return null;
          const update = await orderUpdateMessage(orders, found.id, now, settings, this.jev);
          return { ...found, confirmed: true, byNumber: false, channelType: "IFOOD" as const, update, chatOrder: true };
        }
        const confirmed = state.linkedOrder ? await orders.order.findUnique({ where: { id: state.linkedOrder.id }, include: { items: true } }) : null;
        const linked = confirmed ?? (await latestOrderOf(orders, conversation.contact, now, denied));
        const found = linked ?? (await orderByNumber(orders, history, now, denied));
        if (!found) return null;
        const channel = await orders.channel.findUniqueOrThrow({ where: { id: found.channelId }, select: { type: true } });
        const update = await orderUpdateMessage(orders, found.id, now, settings, this.jev);
        return { ...found, confirmed: !!confirmed, byNumber: !linked, channelType: channel.type, update, chatOrder: false };
      });
      return { conversation, settings, history, lastId: last.id, last, order };
    });
    if (!context) return;
    // A mensagem pronta do Cardápio Web sai logo depois do pedido, e o pedido chega pela integração alguns segundos
    // depois (13/11/2026: o #58 entrou 7 s depois da resposta, e a IA chamou a equipe). Ela espera e procura de novo, uma vez.
    const lastText = (context.last.content as MessageContent).text ?? "";
    if (!context.order && CARDAPIO_WEB_ASK.test(lastText) && now.getTime() - context.last.createdAt.getTime() < ORDER_ARRIVAL_WAIT_MS) {
      await this.ai.add("reply", { tenantId, conversationId }, { delay: ORDER_ARRIVAL_WAIT_MS });
      return;
    }

    const { conversation, settings } = context;
    const state = conversation.automationState as AutomationState;
    let attendance = await attendanceOf(this.presence, tenantId, settings, now);
    // Depois do horário, a equipe que ainda responde nesta conversa é atendente (13/11/2026: a IA disse "estamos sem
    // atendentes, o restaurante está fechado" no meio da conversa com a atendente). O painel aberto sozinho não basta:
    // ele fica aberto de noite no computador da loja.
    if (!attendance.available && attendance.reason === "closed" && teamRepliedSince(context.history, now.getTime() - TEAM_ACTIVE_MS)) {
      if (await this.presence.online(tenantId, now.getTime())) attendance = { available: true };
    }
    let answer: AttendantReply | null = null;
    let failed = false;
    // A causa da falha vai para o evento (só a equipe vê): a análise do dia não depende dos logs da Railway.
    let failure = "";
    const noPhone = !conversation.contact.phone && !CHANNEL_CAPABILITIES[conversation.channel.type].providesPhone;
    // Sem atendente, a IA responde tudo: o limite de respostas só serve para chamar a equipe.
    if (!attendance.available || (state.aiReplies ?? 0) < MAX_AI_REPLIES) {
      const orderFacts = attendantOrderFacts(context.order, noPhone);
      try {
        answer = await this.llm.json(
          tenantId,
          "atendimento",
          AttendantReply,
          attendantMessages(conversation.tenant.name, conversation.channel.type, settings, now, orderFacts, transcript(context.history), attendance, {
            first: !state.aiReplies,
            name: firstName(conversation.contact.name),
            reopened: state.aiReopened && !state.aiReplies,
          }),
        );
      } catch (error) {
        // Sem a principal e sem a reserva, o cliente não fica sem resposta: o atendimento segue no menu.
        failed = true;
        failure = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        this.logger.warn(`IA sem resposta na conversa ${conversationId}: ${failure}`);
      }
    }
    if (answer && !answer.reply && !(answer.skip && !answer.handoff)) {
      failed = true;
      failure = "a resposta veio vazia";
      answer = null;
    }
    // Trava do chat do iFood: a resposta que cita outro número de pedido não sai, e a equipe é chamada.
    const chatCode = context.order?.chatOrder ? (context.order.displayCode ?? context.order.externalOrderId) : null;
    const other = answer && chatCode ? otherOrderNumber(answer.reply, chatCode) : null;
    if (other) {
      failed = true;
      failure = `a resposta citou o pedido #${other}, e este chat é do #${chatCode}`;
      answer = null;
      this.logger.warn(`IA citou outro pedido na conversa ${conversationId}: ${failure}`);
    }
    // A LLM às vezes fala "os links de pedido" sem escrever os endereços (Moby Dick, 13/11): eles vão no fim da resposta,
    // a menos que já estejam na conversa.
    const links = orderLinksOf(settings);
    const sent = (text: string) => links.some((link) => text.includes(link.url));
    if (answer && links.length && !answer.handoff && !answer.skip && /\blinks?\b/i.test(answer.reply) && !sent(answer.reply) && !sent(transcript(context.history))) {
      answer = { ...answer, reply: `${answer.reply}\n${links.map((link) => `${link.label}: ${link.url}`).join("\n")}` };
    }

    const done = await this.db.withTenants(scope, async (tx) => {
      // Enquanto a LLM escrevia, o cliente mandou outra mensagem (o job dela responde) ou a equipe respondeu.
      const latest = await tx.message.findFirst({
        where: { conversationId, direction: { in: ["INBOUND", "OUTBOUND"] } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      const current = (await tx.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { automationState: true } }))
        .automationState as AutomationState;
      if (latest?.id !== context.lastId || current.ai !== "on") return null;

      if (failed && conversation.channel.type === "IFOOD") {
        // O chat do iFood não tem menu (o menu do WhatsApp saía no chat do pedido): como sem a IA, a equipe é chamada e o
        // telefone é pedido a quem não o tem no cadastro.
        await systemEvent(tx, conversation, { event: "ai_fallback", text: `A IA não respondeu (${failure}): a equipe foi chamada` });
        const messages = automationMessagesOf(settings);
        const askPhone = !conversation.contact.phone && !current.phoneCollection;
        const id = await automationMessage(tx, conversation, "handoff", askPhone ? `${messages.ifoodHandoff} ${messages.ifoodPhoneRequest}` : messages.ifoodHandoff);
        await setAutomationState(tx, conversationId, { ...current, ai: "off", triage: "done", ...(askPhone && { phoneCollection: "awaiting_phone" as const }) });
        await systemEvent(tx, conversation, { event: "handoff", text: "Cliente chamando pelo chat do iFood" });
        await callTeam(tx, conversationId);
        return { ids: [id], notify: [], startsWaiting: false };
      }
      if (failed) {
        // O menu segue até o fim do atendimento (a IA sai), e a espera por um atendente continua valendo.
        await systemEvent(tx, conversation, { event: "ai_fallback", text: `A IA não respondeu (${failure}): o atendimento segue no menu` });
        const step = await this.triage.fallbackToMenu(tx, conversationId, {
          ai: "off",
          ...(current.aiWaiting && { aiWaiting: true, aiWaitingReason: current.aiWaitingReason }),
        });
        return { ids: step.send, notify: [], startsWaiting: false };
      }

      // A IA escolheu não responder (despedida repetida, divulgação, robô): nada sai e o atendimento segue com ela.
      if (answer?.skip && !answer.handoff) {
        // Só um "ok" ou "boa noite" na conversa resolvida: ela continua resolvida, sem chamar ninguém.
        if (!current.aiReopened || current.aiReplies) return { ids: [], notify: [], startsWaiting: false };
        await systemEvent(tx, conversation, { event: "ai_skip", text: "O cliente só respondeu ao fim do atendimento: a conversa continua resolvida" });
        await tx.conversation.update({ where: { id: conversationId }, data: { status: "RESOLVED", unreadCount: 0, teamInvolved: false, awaitingAgentSince: null } });
        return { ids: [], notify: [conversationId], startsWaiting: false };
      }

      // Com os links para pedir, o cliente segue sozinho (como a opção "Fazer um pedido" do menu): a equipe não é chamada.
      const sentLinks = !!answer && sent(answer.reply);
      // O cliente precisa da equipe (ou a IA chegou ao limite de respostas). Com atendente, a IA passa a conversa e sai; sem, ela continua
      // atendendo e a conversa espera alguém (aiWaiting).
      // Sem atendente, a resposta que diz "estamos sem atendentes" promete encaminhar a conversa: ela espera alguém mesmo
      // que a LLM tenha respondido handoff = false.
      const promised = !!answer && !attendance.available && /sem atendentes?/i.test(answer.reply);
      const needsTeam = !answer || (answer.handoff && !sentLinks) || promised;
      const handoff = needsTeam && attendance.available;
      const waits = needsTeam && !attendance.available;
      const startsWaiting = waits && !current.aiWaiting;
      // A conversa começa a esperar, mas a resposta não avisa o cliente (fechado: sem a hora em que o restaurante volta).
      const hours = businessHoursOf(settings);
      const reopening = attendance.available ? undefined : attendance.reopening?.match(/\d\d:\d\d/)?.[0];
      const noNotice = startsWaiting && !!answer && (reopening ? !answer.reply.includes(reopening) : !/atendente/i.test(answer.reply));
      // Mensagem automática no lugar da resposta: sem resposta da LLM; passando para a equipe com uma pergunta (que ninguém
      // leria); ou sem o aviso de que não há atendente, sem estar perguntando nada. Se a IA pergunta algo (ex.: o número do
      // pedido), a resposta sai e o aviso vai logo depois.
      // Única pergunta aceita ao passar para a equipe: o pedido do telefone (cliente sem telefone no cadastro).
      const asksPhone = !!answer && noPhone && /telefone/i.test(answer.reply);
      const unfit = !!answer && ((handoff && answer.reply.includes("?") && !asksPhone) || (noNotice && !answer.reply.includes("?")));
      const appendNotice = noNotice && !unfit;
      const reply = answer && !unfit ? answer.reply : null;
      const messages = automationMessagesOf(settings);
      const notice = () =>
        attendance.available
          ? Promise.resolve(null)
          : attendance.reason === "closed"
            ? automationMessage(tx, conversation, "after_hours", fillMessage(hours.closedMessage, { retorno: attendance.reopening ?? "" }))
            : automationMessage(tx, conversation, "no_agents_online", messages.noAgentsOnline);
      const id = reply
        ? (
            await tx.message.create({
              data: {
                tenantId,
                conversationId,
                channelId: conversation.channelId,
                direction: "OUTBOUND",
                type: "TEXT",
                content: { text: reply, aiReply: true } satisfies MessageContent,
                status: "PENDING",
              },
              select: { id: true },
            })
          ).id
        : attendance.available
          ? await automationMessage(tx, conversation, "handoff", messages.handoff)
          : (await notice())!;
      const extra = appendNotice ? await notice() : null;
      // Como no menu: a IA mostra o pedido (a resposta cita o número) e a resposta seguinte do cliente confirma ou não.
      // "É meu" une o cadastro ao do pedido; "não é" faz a IA procurar outro.
      const pending = context.order && !context.order.confirmed ? context.order : null;
      const offered = !!pending && current.aiOfferedOrderId === pending.id;
      const confirmed = pending && offered && answer?.order === "confirmed" ? pending.id : null;
      const deniedId = pending && offered && answer?.order === "denied" ? pending.id : null;
      const code = (pending?.displayCode ?? pending?.externalOrderId ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const offers = !!pending && !confirmed && !deniedId && !!answer && new RegExp(`(?<!\\d)${code}(?!\\d)`).test(answer.reply);
      const notify = confirmed ? await this.confirmOrder(tx, conversationId, confirmed, pending!.byNumber) : [];
      const reason = answer?.reason.trim().slice(0, 200) || undefined;
      // Parece entregador e o cadastro não tem a tag: a conversa abre com a pergunta à equipe, uma vez por atendimento.
      const asksCourier = !!answer?.courier && !conversation.contact.tags.includes(COURIER_TAG) && !current.courierCheck && !current.courierChecked;
      await setAutomationState(tx, conversationId, {
        ...current,
        ai: handoff ? "off" : "on",
        // A resposta do cliente com o telefone é cadastrada pela coleta de telefone, sem repetir o pedido.
        ...(handoff && asksPhone && !current.phoneCollection && { phoneCollection: "awaiting_phone" as const }),
        aiReplies: (current.aiReplies ?? 0) + 1,
        ...(startsWaiting && { aiWaiting: true, aiWaitingReason: reason }),
        ...(confirmed && { linkedOrder: { id: confirmed, at: now.toISOString() } }),
        ...(deniedId && { aiDeniedOrderIds: [...(current.aiDeniedOrderIds ?? []), deniedId] }),
        ...(offers && pending && { aiOfferedOrderId: pending.id }),
        ...(asksCourier && { courierCheck: { reason: reason ?? "A IA acha que quem escreve é um entregador." } }),
      });
      if (asksCourier) {
        await systemEvent(tx, conversation, { event: "courier_check", text: "A IA acha que quem escreve é um entregador: a equipe confirma" });
      }
      if (handoff) {
        await systemEvent(tx, conversation, { event: "handoff", text: `IA passou o atendimento para a equipe${reason ? `: ${reason}` : ""}` });
        await tx.conversation.update({ where: { id: conversationId }, data: { awaitingAgentSince: new Date(), awaitingAgentQuiet: false } });
      }
      if (startsWaiting && !attendance.available) {
        const why = { closed: "o restaurante está fechado", full_auto: "o 100% automático está ligado", offline: "não há atendente online" }[attendance.reason];
        await systemEvent(tx, conversation, {
          event: "awaiting_agent",
          waitingReason: attendance.reason,
          text:`Cliente precisa da equipe${reason ? ` (${reason})` : ""}, mas ${why}: a conversa vai para a equipe quando houver atendente`,
        });
        // Pendente: não é encerrada por inatividade enquanto espera.
        await tx.conversation.update({ where: { id: conversationId }, data: { status: "PENDING" } });
      }
      return { ids: extra ? [id, extra] : [id], notify, startsWaiting };
    });
    if (!done) return;
    if (done.startsWaiting) await this.presence.markWaiting(tenantId);
    await dispatch(this.outbound, this.realtime, tenantId, conversationId, done.ids);
    for (const other of done.notify) this.realtime.inboxChanged(tenantId, other);
  }

  /**
   * O cliente confirmou o pedido: o card dele entra na conversa e o cadastro é unido ao do pedido. Achado pelo número,
   * não une: saber o número não prova que o pedido é dele, e a equipe decide em Clientes → Duplicados.
   * Devolve as outras conversas afetadas.
   */
  private async confirmOrder(tx: TenantTx, conversationId: string, orderId: string, byNumber: boolean): Promise<string[]> {
    const conversation = await tx.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { id: true, tenantId: true, channelId: true, contact: true },
    });
    const order = await withOrderTenants(this.db, tx, conversation.channelId, (orders) =>
      orders.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { contact: true, channel: { select: { type: true } }, tenant: { select: { name: true } } },
      }),
    );
    await systemEvent(tx, conversation, { event: "order", orderId });
    if (byNumber && order.tenantId === conversation.tenantId && order.contact.id !== conversation.contact.id) {
      await systemEvent(tx, conversation, {
        event: "possible_duplicate",
        text: `O cliente confirmou o pedido #${order.displayCode} pelo número, mas ele está no cadastro de ${order.contact.name ?? "outro cliente"}. Se for a mesma pessoa, una os cadastros em Clientes → Duplicados`,
      });
      return [];
    }
    return linkOrderContact(tx, conversation, order);
  }
}
