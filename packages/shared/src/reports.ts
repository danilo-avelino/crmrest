import { z } from "zod";

/** Período do relatório de avaliações: hoje (Brasília), últimos 7 ou 30 dias. */
export const REPORT_PERIODS = ["today", "7d", "30d"] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/** Por que um atendimento precisou da equipe: a IA classifica ao avaliar o atendimento (módulo Atendimento com IA). */
export const TEAM_REASONS = {
  atraso: "Reclamação de atraso",
  problema_pedido: "Problema no pedido",
  troca_reembolso: "Troca ou reembolso",
  fora_do_cardapio: "Fora do que a IA sabe",
  pediu_pessoa: "Cliente pediu uma pessoa",
  pedido_grande: "Pedido grande ou evento",
  outro: "Outro motivo",
} as const;
export type TeamReason = keyof typeof TEAM_REASONS;

/** O assunto do contato: a IA classifica ao avaliar o atendimento. */
export const CONTACT_SUBJECTS = {
  pedido_novo: "Fazer um pedido",
  andamento_pedido: "Andamento do pedido",
  problema_pedido: "Problema com o pedido",
  cardapio: "Cardápio e preços",
  informacoes: "Horário, endereço e entrega",
  pagamento: "Pagamento",
  elogio: "Elogio",
  outro: "Outro assunto",
} as const;
export type ContactSubject = keyof typeof CONTACT_SUBJECTS;

/** O que deu errado no atendimento (a conversa), segundo a IA. */
export const SERVICE_ISSUES = {
  demora: "Demora para responder",
  informacao_errada: "Informação errada",
  sem_solucao: "Ficou sem solução",
  tom: "Tom inadequado",
} as const;
export type ServiceIssue = keyof typeof SERVICE_ISSUES;

/** De quem foi a falha que incomodou o cliente: de quem atendeu ou da operação (cozinha, entrega). */
export const SERVICE_FAULTS = { atendimento: "Atendimento", operacao: "Cozinha ou entrega" } as const;
export type ServiceFault = keyof typeof SERVICE_FAULTS;

/** Chance de perder o cliente a partir da qual o atendimento conta como "em risco". */
export const CHURN_RISK_ALERT = 0.5;

/** Por que a conversa esperou atendente: restaurante fechado, 100% automático ligado ou ninguém online. */
export type WaitingReason = "closed" | "full_auto" | "offline";

/** Avaliações do iFood: últimos 7, 30 ou 90 dias (o iFood só conta na nota os últimos 3 meses). */
export const IFOOD_REVIEW_PERIODS = ["7d", "30d", "90d"] as const;
export type IfoodReviewPeriod = (typeof IFOOD_REVIEW_PERIODS)[number];

/**
 * Uma avaliação do iFood. `status`: CREATED (processando), NOT_REPLIED (nota abaixo de 5 com comentário, aguarda a
 * resposta da loja por 5 dias), REPLIED (respondida; o cliente pode mudar a nota) ou PUBLISHED. Sem comentário ou com
 * nota 5, ela já nasce publicada e não aceita resposta.
 */
export type IfoodReviewDto = {
  id: string;
  /** Canal (loja do iFood) da avaliação: a resposta vai por ele. */
  storeId: string;
  storeName: string;
  score: number;
  comment: string | null;
  customerName: string | null;
  createdAt: string;
  status: string;
  /** PRIVATE: só a loja e o cliente veem, e não conta na nota. */
  visibility: string | null;
  orderCode: string | null;
  /** Respostas do questionário ("Entrega", "Sabor"...). */
  answers: string[];
  replies: { text: string; from: string | null; createdAt: string | null }[];
  /** Aguardando resposta: até quando a loja pode responder (5 dias depois da avaliação). */
  replyBy: string | null;
};

export type IfoodReviewsDto = {
  /** Nota de cada loja no iFood (média das avaliações válidas dos últimos 3 meses). */
  stores: { id: string; name: string; score: number | null; validReviews: number; totalReviews: number }[];
  /** Lojas que o iFood não deixou consultar: `forbidden` = acesso às avaliações ainda não liberado para o Dish Desk. */
  unavailable: { id: string; name: string; reason: "forbidden" | "error" }[];
  /** Mais recentes primeiro. */
  reviews: IfoodReviewDto[];
};

/** O iFood aceita respostas de 10 a 300 caracteres. */
export const IfoodReviewAnswerRequest = z.object({ text: z.string().trim().min(10).max(300) });
export type IfoodReviewAnswerRequest = z.infer<typeof IfoodReviewAnswerRequest>;

/** Números de um atendente (ou de toda a equipe, no resumo). */
export type AgentMetrics = {
  /** Avaliações recebidas e a nota média (1 a 5). */
  ratings: number;
  averageScore: number | null;
  /** Atendimentos passados pela automação e respondidos por uma pessoa, e o tempo médio até essa resposta. */
  answered: number;
  averageResponseSeconds: number | null;
};

/** Relatório da aba Avaliações (só administradores). */
export type RatingsReportDto = {
  /** Toda a equipe; `handoffs` conta também os atendimentos ainda sem resposta. */
  summary: AgentMetrics & { handoffs: number };
  /**
   * Conversas chamadas (automação passou à equipe ou chegaram fora do horário) que terminaram o dia sem resposta de
   * uma pessoa; uma por conversa e dia (Brasília). No dia de hoje, vale "até agora".
   */
  unanswered: { conversationId: string; contactName: string | null; calledAt: string; afterHours: boolean }[];
  /** Clientes com a tag "Em recuperação" agora (não depende do período). */
  recovering: number;
  /** Quantas respostas à pesquisa deram cada nota no período: a posição 0 é a nota 1; a 4, a nota 5. */
  scoreCounts: number[];
  /** A nota vai para quem respondeu por último; o tempo, para quem deu a primeira resposta. */
  agents: (AgentMetrics & { userId: string | null; name: string })[];
  recent: {
    id: string;
    score: number;
    createdAt: string;
    conversationId: string;
    contactName: string | null;
    agentName: string | null;
    orderCode: string | null;
  }[];
  /** Avaliações dos atendimentos pela IA no período; null = restaurante sem o módulo Atendimento com IA. */
  ai: {
    evaluations: number;
    averageScore: number | null;
    /** Atendimentos com o problema resolvido; clientes que reagiram e, entre eles, os satisfeitos; notas 1 e 2. */
    resolved: number;
    reacted: number;
    satisfied: number;
    lowScores: number;
    /** Atendimentos resolvidos em que só a IA (e as automações) atendeu: não são avaliados, só contados. */
    onlyAi: number;
    /** Atendimentos que passaram pela equipe (os avaliados). */
    withTeam: number;
    /** Motivos da passagem para a equipe, do mais comum ao menos. */
    teamReasons: { reason: TeamReason; count: number }[];
    /** Assuntos dos atendimentos avaliados, do mais comum ao menos (sem as avaliações antigas, que não têm assunto). */
    subjects: { subject: ContactSubject; count: number }[];
    /** O que deu errado nos atendimentos avaliados, do mais comum ao menos. */
    issues: { issue: ServiceIssue; count: number }[];
    /** Atendimentos com falha, por quem falhou. */
    faults: Record<ServiceFault, number>;
    /** Atendimentos em que a chance de perder o cliente passou de CHURN_RISK_ALERT. */
    atRisk: number;
    /** Vezes que a IA precisou da equipe sem haver atendente, por motivo. */
    waiting: Record<WaitingReason, number>;
    /** Revisão automática das respostas de cada atendente: reescritas pela IA e mantidas como ele escreveu. */
    reviews: { userId: string; name: string; rewritten: number; kept: number }[];
    /** A resposta reescrita mais recente: o que o atendente escreveu e o que foi enviado. */
    rewriteExample: { agentName: string | null; original: string; text: string; createdAt: string } | null;
    /** A avaliação vai para quem da equipe respondeu por último; userId null = só a IA atendeu. */
    agents: { userId: string | null; name: string; evaluations: number; averageScore: number | null }[];
    recent: {
      id: string;
      conversationId: string;
      contactName: string | null;
      /** Quem da equipe respondeu por último; null = só a IA atendeu. */
      userId: string | null;
      agentName: string | null;
      score: number;
      resolved: boolean;
      satisfied: boolean | null;
      /** Por que precisou da equipe; null = só a IA atendeu. */
      teamReason: TeamReason | null;
      /** Nulos nas avaliações antigas; `issue` e `fault` nulos também quando nada deu errado. */
      subject: ContactSubject | null;
      issue: ServiceIssue | null;
      fault: ServiceFault | null;
      churnRisk: number | null;
      createdAt: string;
    }[];
    /** Respostas que a revisão da IA bloqueou por má conduta (ofensa, grosseria), com o texto que o atendente escreveu. */
    misconduct: {
      messageId: string;
      conversationId: string;
      contactName: string | null;
      agentName: string | null;
      original: string;
      reason: string;
      createdAt: string;
    }[];
  } | null;
};
