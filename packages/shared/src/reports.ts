import { z } from "zod";

/** Período do relatório de avaliações: hoje (Brasília), últimos 7 ou 30 dias. */
export const REPORT_PERIODS = ["today", "7d", "30d"] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

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
    /** De 0 a 1: atendimentos com o problema resolvido; e clientes satisfeitos entre os que reagiram. */
    resolvedRate: number | null;
    satisfiedRate: number | null;
    /** A avaliação vai para quem da equipe respondeu por último; userId null = só a IA atendeu. */
    agents: { userId: string | null; name: string; evaluations: number; averageScore: number | null }[];
    recent: {
      id: string;
      conversationId: string;
      contactName: string | null;
      agentName: string | null;
      score: number;
      resolved: boolean;
      satisfied: boolean | null;
      summary: string;
      createdAt: string;
    }[];
  } | null;
};
