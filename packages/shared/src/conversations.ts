import type { OrderOrigin } from "./channels.js";
import type {
  ChannelStatus,
  ChannelType,
  ConversationStatus,
  Direction,
  MessageStatus,
  MessageType,
  OrderStatus,
  TenantRole,
} from "@dishdesk/database/enums";
import { ConversationStatus as ConversationStatusEnum } from "@dishdesk/database/enums";
import { z } from "zod";
import type { ContactSubject, ServiceFault, ServiceIssue, TeamReason, WaitingReason } from "./reports.js";

/** Conteúdo de uma mensagem, conforme o tipo (texto, mídia, evento do sistema, nota...). */
export type MessageContent = {
  text?: string;
  /** Mensagem enviada por automação (coleta de telefone, menu de atendimento, pesquisa de satisfação, encerramento). */
  automation?:
    | "phone_collection"
    | "phone_reminder"
    | "phone_confirmation"
    | "menu"
    | "order_number_request"
    | "order_lookup"
    | "order_confirmed"
    | "order_forecast"
    | "order_ready"
    | "order_dispatched"
    | "order_delivered"
    | "order_canceled"
    | "order_links"
    | "handoff"
    | "no_agents_online"
    | "survey"
    | "survey_thanks"
    | "after_hours"
    | "inactivity_close"
    | "courier_menu"
    | "courier_arrival"
    | "courier_arrival_confirmed"
    | "courier_front_desk"
    | "courier_front_desk_confirmed"
    | "courier_customer_link"
    | "courier_problem_request"
    | "ifood_observation_ask"
    | "menu_order_confirmed"
    | "menu_cart_recovery"
    | "menu_recovery_offer"
    | "menu_pix"
    | "menu_audio_failed";
  /** Evento do sistema mostrado na conversa. */
  event?:
    | "conversation_opened"
    | "phone_collected"
    | "phone_pending"
    | "order"
    | "opt_out"
    | "contacts_merged"
    | "merge_conflict"
    /** O telefone que o cliente digitou já está em outro cadastro: a equipe decide se une (Clientes → Duplicados). */
    | "possible_duplicate"
    /** Pedido confirmado é de outro restaurante atendido pelo canal: os cadastros ficam separados. */
    | "order_other_restaurant"
    | "order_ambiguous"
    | "rating"
    | "handoff"
    /** A IA precisa da equipe, mas não há atendente: a conversa vai para a equipe quando houver alguém. */
    | "awaiting_agent"
    /** A principal e a reserva da IA não responderam: o atendimento segue no menu. */
    | "ai_fallback"
    /** O cliente só respondeu "ok" ou "boa noite" numa conversa resolvida: a IA não respondeu e ela continua resolvida. */
    | "ai_skip"
    /** A IA acha que quem escreve é um entregador sem a tag: a equipe confirma no modal da conversa. */
    | "courier_check"
    /** O agente de pedidos do cardápio mexeu no carrinho (adicionou, trocou, definiu a entrega, resumiu). */
    | "menu_agent"
    | "cancellation_alert"
    /** Mensagens seguidas que o Dish Desk não exibe: o contato ganhou a tag Bot e a conversa foi resolvida. */
    | "bot_detected"
    /** A equipe apertou "Resolver": quem resolveu e a hora ficam marcados na conversa (só a equipe vê). */
    | "resolved"
    /** Prevenção de fraude: só a equipe vê. */
    | "fraud_alert"
    | "order_kept"
    | "order_canceled_by_team"
    | "order_cancel_refused"
    | "fraud_marked"
    | "fraud_unmarked";
  orderId?: string;
  /** O card do pedido traz o botão de conversar com o cliente (pedido informado por um entregador). */
  customerChat?: boolean;
  /** Template aprovado do WhatsApp (o único envio permitido fora da janela de 24h). */
  template?: { name: string; language: string; variables: string[] };
  /** `forwardOf`: mídia encaminhada de outra mensagem do restaurante; o arquivo é buscado nela na hora do envio. */
  media?: {
    mimeType: string;
    externalMediaId?: string;
    url?: string;
    filename?: string;
    forwardOf?: string;
    /** Áudio de restaurante com o módulo MENU: chave no storage privado (F5-01), servida no lugar da plataforma. */
    storageKey?: string;
    /** Duração em segundos, quando a plataforma informa. */
    seconds?: number;
    /** Por que o áudio não foi guardado: too_long, too_large, no_source ou failed. */
    storeError?: string;
    /** Transcrição do áudio (F5-02): enquanto não há provedor, "pending_provider". */
    transcription?: string;
  };
  /** Mensagem encaminhada de outra conversa pela equipe. */
  forwarded?: boolean;
  /**
   * Pergunta com opções fechadas do agente de pedidos (F4-05). `text` já traz a versão numerada (o que a Inbox mostra e
   * o que sai nos conectores sem botões); na API oficial do WhatsApp sai como botões ou lista, com `question` no corpo.
   */
  choices?: { question: string; options: { id: string; title: string }[] };
  /** Mensagem recebida: id do botão ou do item de lista que o cliente tocou (WhatsApp Cloud API). */
  replyId?: string;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  /** Mensagem recebida de um tipo que o Dish Desk não exibe: o tipo na plataforma (ex.: "contactMessage"). */
  unsupported?: string;
  /**
   * Mensagem recebida: id de quem escreveu no canal (wa_id, IGSID). Um cadastro pode ter mais de um perfil no mesmo
   * canal (cadastros unidos): a resposta vai para o perfil que escreveu por último.
   */
  from?: string;
  /** Resposta escrita pela IA no atendimento com IA (módulo AI), sem atendente. */
  aiReply?: boolean;
  /** Resposta que a equipe mandou pelo WhatsApp do celular (WhatsApp por QR Code), fora do Dish Desk. */
  fromPhone?: boolean;
  /**
   * Chat do iFood: mensagem que a loja digitou no Gestor de Pedidos logo depois de uma mensagem do cliente. Conta como
   * resposta da equipe (as automáticas da loja, que chegam sem mensagem do cliente antes, não ganham a marca).
   */
  storeReply?: boolean;
  /**
   * Revisão da resposta do atendente pela IA, antes do envio: "pending" = ainda no worker; "rewritten" = o texto é o da
   * IA e `original` é o que o atendente escreveu (só a equipe vê); "kept" = saiu o texto do atendente; "blocked" = má
   * conduta (ofensa, grosseria): a mensagem não foi enviada e virou um alerta interno, com o texto em `original` e o
   * motivo em `misconduct`, que vai para as Avaliações do gestor.
   */
  aiReview?: "pending" | "rewritten" | "kept" | "blocked";
  original?: string;
  misconduct?: string;
  /** Evento `awaiting_agent`: por que não havia atendente (vai para as Avaliações). */
  waitingReason?: WaitingReason;
};

/** Avaliação de um atendimento pela IA, feita quando a conversa é resolvida (só administradores veem). */
export type ConversationEvaluationDto = {
  id: string;
  conversationId: string;
  resolved: boolean;
  /** null = o cliente não reagiu. */
  satisfied: boolean | null;
  /** Nota em porcentagem (1 a 100). */
  score: number;
  /** Só nas avaliações antigas (feitas pela LLM); as do Jev não têm resumo. */
  summary: string | null;
  /** Quem da equipe respondeu por último; null = só a IA e as automações atenderam. */
  agentName: string | null;
  /** Por que precisou da equipe; null = só a IA atendeu. */
  teamReason: TeamReason | null;
  /** O assunto do contato; null nas avaliações antigas. */
  subject: ContactSubject | null;
  /** O que deu errado e de quem foi a falha; null = nada (ou avaliação antiga). */
  issue: ServiceIssue | null;
  fault: ServiceFault | null;
  /** Chance (0 a 1) de perder o cliente; null nas avaliações antigas. */
  churnRisk: number | null;
  /** Modelo de IA que avaliou. */
  model: string;
  createdAt: string;
};

/** Conversa na aba do cliente: `evaluations` são as avaliações da IA (só administradores recebem). */
export type ContactConversationItem = ConversationListItem & { evaluations: ConversationEvaluationDto[] };

export type MessageDto = {
  id: string;
  conversationId: string;
  direction: Direction;
  type: MessageType;
  content: MessageContent;
  status: MessageStatus | null;
  statusError: string | null;
  sentBy: { id: string; name: string } | null;
  createdAt: string;
};

/** Forma de pagamento do pedido do cardápio próprio: `pix` é pago no app; as demais, na entrega (ou na retirada). */
export type MenuOrderPayment = { method: "pix" | "cash" | "credit" | "debit" | "pix_on_delivery"; changeForCents: number | null };

/** Por onde o pedido do cardápio próprio nasceu: o site, a conversa com a IA no WhatsApp ou um anúncio. */
export type MenuOrderOrigin = "site" | "whatsapp_ai" | "ad";

/** O que a cozinha e o atendente precisam saber de um pedido do cardápio próprio (source MENU); null nos demais. */
export type MenuOrderInfo = {
  takeout: boolean;
  /** Horário marcado (pedido agendado); null: o quanto antes. */
  scheduledFor: string | null;
  payment: MenuOrderPayment | null;
  origin: MenuOrderOrigin;
  /** Vantagem aplicada (cupom da tag ou presente da casa); ausente em pedido sem vantagem. */
  benefit?: { label: string; discountCents: number; freeDelivery: boolean } | null;
};

export type OrderDto = {
  id: string;
  /** De onde veio o pedido (iFood, Cardápio Web). */
  channelType: OrderOrigin;
  displayCode: string | null;
  status: OrderStatus;
  subtotal: string;
  deliveryFee: string;
  total: string;
  placedAt: string;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  /** `unitPrice` já inclui os complementos escolhidos (`options`, na ordem do pedido). */
  items: { name: string; quantity: number; unitPrice: string; notes: string | null; options: string[] }[];
  /** Só no pedido do cardápio próprio. Ausente em API antiga (deploy em andamento). */
  menu?: MenuOrderInfo | null;
  /** Pedido de outro restaurante atendido pelo canal da conversa (Configurações → Integrações): o nome dele. */
  restaurantName?: string;
};

/**
 * Por onde a equipe fala com o cliente de um pedido: WhatsApp, se o cadastro tem telefone e o restaurante tem um número
 * conectado; senão, o chat do iFood do pedido. null = não há como conversar pelo Dish Desk.
 */
export type OrderCustomerChat = { channel: Extract<ChannelType, "WHATSAPP" | "IFOOD"> | null; contactName: string | null };

/** Item da lista de conversas da Inbox (no painel master, `tenant` diz de qual restaurante é). */
export type ConversationListItem = {
  id: string;
  tenant: { id: string; name: string };
  status: ConversationStatus;
  unreadCount: number;
  createdAt: string;
  lastMessageAt: string | null;
  windowExpiresAt: string | null;
  /** Aberta pelo alerta de fraude para um pedido sem conversa: o cliente não está nela, só cabem notas internas. */
  teamOnly: boolean;
  /** O cliente tem um pedido com alerta de fraude à espera da decisão da equipe. */
  fraudAlert: boolean;
  /** Desde quando o cliente espera um atendente (a automação chamou a equipe e ninguém respondeu); null = não espera. */
  awaitingAgentSince: string | null;
  /** O chamado não é urgente (entregador com outro assunto): aviso sonoro discreto, sem o alarme. */
  awaitingAgentQuiet: boolean;
  channel: { id: string; type: ChannelType; name: string };
  contact: { id: string; name: string | null; phoneStatus: string | null; tags: string[] };
  assignedUser: { id: string; name: string } | null;
  lastMessage: { direction: Direction; preview: string } | null;
  /** Código do último pedido ligado à conversa (cabeçalho "iFood · #485329"). */
  orderCode: string | null;
  /** A IA acha que quem escreve é um entregador (sem a tag Entregador): a conversa abre perguntando à equipe. `reason`: o porquê. */
  courierCheck: { reason: string } | null;
};

export type ConversationPage = { items: ConversationListItem[]; nextCursor: string | null };
/**
 * Conversas por status e quantas estão chamando um atendente (alarme da Inbox); `awaitingQuiet` = quantas delas chamam sem urgência.
 * `urgentSince` = desde quando espera o chamado urgente mais antigo (mostrado na tela inicial da Inbox).
 * `unread` = mensagens não lidas nas conversas abertas e pendentes (aviso de nova mensagem fora da Inbox).
 * `OPEN` conta só as abertas com a equipe (as da aba Automáticos ficam de fora).
 */
export type ConversationCounts = Record<ConversationStatus, number> & {
  awaitingAgent: number;
  awaitingQuiet: number;
  urgentSince: string | null;
  unread: number;
};
/**
 * Conversas do dia (desde a meia-noite de Brasília), no início da Inbox. `opened` = conversas em que o cliente escreveu
 * hoje; `resolved` = quantas delas estão resolvidas. Cada conversa de `opened` cai em `withTeam` ou em `withoutTeam`:
 * com a equipe = hoje uma pessoa respondeu (pelo painel ou pelo celular), a conversa foi passada para a equipe ou ficou
 * esperando a equipe; sem a equipe = só a IA e as automações. `averageResponseSeconds` = da passagem à primeira resposta de uma pessoa (como na aba Avaliações); `evaluations` e
 * `aiScore` = avaliações do atendimento feitas pela IA hoje e a nota média delas (em porcentagem, 1 a 100).
 */
export type ConversationDayStats = {
  opened: number;
  resolved: number;
  withTeam: number;
  withoutTeam: number;
  averageResponseSeconds: number | null;
  evaluations: number;
  aiScore: number | null;
};
/** `evaluations`: avaliações da IA, na ordem em que foram feitas (vazio para quem não é administrador). */
export type ConversationMessages = { messages: MessageDto[]; orders: Record<string, OrderDto>; evaluations: ConversationEvaluationDto[] };

/** Dias (AAAA-MM-DD, Brasília) do cartão "Hoje até agora"; sem eles, só hoje. */
export const ConversationDayQuery = z.object({
  tenantId: z.uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type ConversationDayQuery = z.infer<typeof ConversationDayQuery>;

export const ConversationListQuery = z.object({
  /**
   * ACTIVE: abertas e pendentes em que a equipe foi chamada ou atuou (o que ela ainda precisa tratar); OPEN também fica só
   * com essas. AUTO: abertas que só tiveram automação (menu, IA, avisos do pedido), sem chamar a equipe.
   */
  status: z.enum([...Object.values(ConversationStatusEnum), "ACTIVE", "AUTO"]).optional(),
  search: z.string().trim().max(100).optional(),
  tenantId: z.uuid().optional(),
  cursor: z.uuid().optional(),
});
export type ConversationListQuery = z.infer<typeof ConversationListQuery>;

export const SendMessageRequest = z.object({ text: z.string().trim().min(1).max(4096) });
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

/** Encaminhar uma mensagem para outra conversa do mesmo restaurante. */
export const ForwardMessageRequest = z.object({ conversationId: z.uuid() });
export type ForwardMessageRequest = z.infer<typeof ForwardMessageRequest>;

/** Tipos de mensagem que podem ser encaminhados: texto, localização e mídia. */
export const FORWARDABLE_TYPES = ["TEXT", "IMAGE", "AUDIO", "VIDEO", "DOCUMENT", "LOCATION"] as const;

/** Resposta sugerida pela IA para o atendente editar e enviar (E28). */
export type ReplySuggestionDto = { text: string };

/** Template aprovado na conta do WhatsApp; `variables` = quantos {{n}} o corpo tem. */
export type WhatsAppTemplate = { name: string; language: string; category: string; body: string; variables: number };

export const SendTemplateRequest = z.object({
  name: z.string().min(1).max(512),
  language: z.string().min(2).max(15),
  variables: z.array(z.string().trim().min(1).max(1024)).max(20),
});
export type SendTemplateRequest = z.infer<typeof SendTemplateRequest>;

/** Corpo do template com as variáveis no lugar de {{1}}, {{2}}... */
export function renderTemplate(body: string, variables: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (match, index: string) => variables[Number(index) - 1] ?? match);
}

export const UpdateConversationRequest = z
  .object({
    status: z.enum(ConversationStatusEnum).optional(),
    assignedUserId: z.uuid().nullable().optional(),
  })
  .refine((body) => body.status !== undefined || body.assignedUserId !== undefined, "Nada para alterar.");
export type UpdateConversationRequest = z.infer<typeof UpdateConversationRequest>;

/** Resposta da equipe à pergunta da IA: quem escreve é (true) ou não é (false) um entregador. */
export const CourierCheckRequest = z.object({ courier: z.boolean() });
export type CourierCheckRequest = z.infer<typeof CourierCheckRequest>;

/** Membro de um restaurante, para atribuir conversas. */
export type MemberDto = { id: string; name: string; tenantId: string; role: TenantRole };

export type QuickReplyDto = { id: string; tenantId: string; shortcut: string; content: string };

/**
 * Canal do restaurante como a equipe o vê (sem credenciais): para avisar quando ele precisa ser reconectado ou quando
 * o token está para vencer (tokenExpiresAt em ISO; null = não vence ou não conferido).
 */
export type ChannelHealthDto = {
  id: string;
  tenantId: string;
  /** Outros restaurantes que o canal atende (o WhatsApp de um grupo). */
  servedTenantIds: string[];
  type: ChannelType;
  name: string;
  status: ChannelStatus;
  tokenExpiresAt: string | null;
};
/**
 * Widget do iFood na Inbox: id do widget da plataforma e as lojas iFood do usuário (o iFood aceita até 10).
 * `chat`: o chat do widget é copiado para a Inbox pela extensão do Chrome (trava IFOOD_CHAT_BRIDGE da API).
 * `extensionUrl`: página da extensão na Chrome Web Store, para o botão "Instalar" (null enquanto ela não for publicada).
 */
export type IfoodWidgetDto = { widgetId: string | null; merchantIds: string[]; chat: boolean; extensionUrl: string | null };

/** Conversa de um pedido como o widget do iFood mostra: o painel lê pela extensão e manda inteira, a cada mudança. */
export const IfoodChatSync = z.object({
  /** Número do pedido no cabeçalho da conversa ("#6530"), sem o "#". */
  orderCode: z.string().regex(/^\d{1,10}$/),
  messages: z
    .array(
      z.object({
        direction: z.enum(["INBOUND", "OUTBOUND"]),
        text: z.string().trim().min(1).max(4096),
        /** Hora que o widget mostra na mensagem (o dia vem do pedido). */
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/),
      }),
    )
    .max(200),
});
export type IfoodChatSync = z.infer<typeof IfoodChatSync>;
/** `found: false` = o Dish Desk ainda não tem o pedido dessa conversa (o polling do iFood não o trouxe). */
export type IfoodChatSyncResult = { found: boolean };

/**
 * O que o painel deve digitar no chat do pedido, no widget: uma resposta escrita na Inbox ou um convite de avaliação. O
 * convite não tem conversa, e `messageId` é o id dele. `customer`: só digita na conversa desse cliente.
 */
export type IfoodChatOutboxItem = { messageId: string; conversationId?: string; orderCode: string; text: string; customer?: string };

/** O que aconteceu com uma resposta da fila do chat do iFood. */
export const IfoodChatSendResult = z.object({
  status: z.enum(["SENT", "FAILED"]),
  error: z.string().trim().min(1).max(300).optional(),
});
export type IfoodChatSendResult = z.infer<typeof IfoodChatSendResult>;

/** Chat do widget que o painel não conseguiu copiar: o motivo e, quando ajuda, o HTML da conversa. Vai só para o log da API. */
export const IfoodChatReport = z.object({
  orderCode: z.string().regex(/^\d{1,10}$/),
  reason: z.string().trim().min(1).max(300),
  detail: z.string().max(20_000).optional(),
});
export type IfoodChatReport = z.infer<typeof IfoodChatReport>;
