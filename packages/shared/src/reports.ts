/** Período do relatório de avaliações: hoje (Brasília), últimos 7 ou 30 dias. */
export const REPORT_PERIODS = ["today", "7d", "30d"] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

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
};
