import type { ConversationCounts } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/components/auth/auth-provider";
import { useAgentAlarm } from "@/hooks/use-agent-alarm";
import { useCallNotifications } from "@/hooks/use-call-notifications";

/** Contagens da Inbox de todos os restaurantes do usuário. O realtime atualiza as chaves que começam em "counts". */
export function useConversationCounts() {
  const { request } = useAuth();
  return useQuery({
    queryKey: ["counts", null],
    queryFn: () => request<ConversationCounts>("/conversations/counts"),
  });
}

/**
 * Aviso de chamado de atendente (bipe, contagem falada e notificação) para todos os restaurantes do usuário.
 * Chamado sem urgência (entregador com outro assunto) tem a própria faixa, mas entra na mesma contagem falada.
 */
export function useCallSignals() {
  const counts = useConversationCounts();
  const quiet = counts.data?.awaitingQuiet ?? 0;
  const calling = (counts.data?.awaitingAgent ?? 0) - quiet;
  const urgentSince = counts.data?.urgentSince ?? null;
  const alarm = useAgentAlarm(calling + quiet, urgentSince);
  useCallNotifications(counts.data ? { calling, quiet } : null, alarm.blocked, urgentSince);
  return { counts, calling, quiet, alarm };
}
