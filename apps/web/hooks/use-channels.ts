import type { ChannelHealthDto } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/components/auth/auth-provider";

/** Canais do restaurante e a saúde de cada um. Uma consulta só para a faixa, a lista e os avisos. */
export function useChannels() {
  const { request } = useAuth();
  return useQuery({
    queryKey: ["channels"],
    queryFn: () => request<ChannelHealthDto[]>("/channels"),
    refetchInterval: 60_000,
  });
}
