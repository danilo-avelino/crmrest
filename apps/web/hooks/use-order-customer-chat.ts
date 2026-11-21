import type { OrderCustomerChat } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/components/auth/auth-provider";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";

/** Por onde a equipe fala com o cliente do pedido; sem canal, não há botão de conversa. */
export function useOrderCustomerChat(orderId: string) {
  const { request } = useAuth();
  return useQuery({
    queryKey: ["order-customer-chat", orderId],
    queryFn: () => request<OrderCustomerChat>(`/orders/${orderId}/customer-chat`),
  });
}

/** Abre (ou cria) a conversa com o cliente do pedido e chama `onOpen` com ela. `via`: o canal, quando o pedido não é do WhatsApp. */
export function useOpenOrderChat(orderId: string, onOpen: (conversationId: string) => void) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  return async (via?: "ifood") => {
    try {
      const { conversationId } = await request<{ conversationId: string }>(`/orders/${orderId}/customer-chat${via ? `?via=${via}` : ""}`, { method: "POST" });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      onOpen(conversationId);
    } catch (failure) {
      toast(failure instanceof ApiError ? failure.message : "Não foi possível abrir a conversa.");
    }
  };
}
