"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { SESSION_KEY, useAuth } from "@/components/auth/auth-provider";

const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL ?? "http://localhost:4000";
const INBOX_QUERIES = ["conversations", "counts", "conversation", "messages", "contact"];
/** No máximo uma renovação de sessão por minuto a pedido do realtime: evita laço se o servidor seguir recusando. */
const RENEW_INTERVAL_MS = 60_000;

/**
 * Conecta ao realtime da API; cada aviso faz o painel buscar de novo o que mudou.
 * Devolve `true` enquanto a conexão estiver caída (o Socket.IO tenta reconectar sozinho).
 */
export function useInboxRealtime(): boolean {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const token = session?.accessToken;
  const connectedBefore = useRef(false);
  const lastRenew = useRef(0);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (!token) return;
    const socket = io(REALTIME_URL, { auth: { token }, transports: ["websocket"] });
    socket.on("inbox.changed", ({ conversationId }: { conversationId: string }) => {
      // "channels": um envio pode ter mudado a saúde do canal (token recusado ou de volta).
      for (const queryKey of [["conversations"], ["counts"], ["conversation", conversationId], ["messages", conversationId], ["contact"], ["channels"], ["current-order", conversationId]]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    });
    // Reconexão (API reiniciou, rede caiu) ou conexão nova com token renovado: avisos podem ter se perdido no intervalo.
    socket.on("connect", () => {
      setOffline(false);
      if (connectedBefore.current) {
        for (const key of INBOX_QUERIES) void queryClient.invalidateQueries({ queryKey: [key] });
      }
      connectedBefore.current = true;
    });
    // O servidor recusou o token (expirado depois de o computador dormir, por exemplo) e o Socket.IO não tenta de novo
    // sozinho: renova a sessão, e o token novo recria a conexão.
    socket.on("connect_error", () => setOffline(true));
    socket.on("disconnect", (reason) => {
      // Rede caiu ou API reiniciou; "io client disconnect" é a troca de token, que já abre outra conexão.
      if (reason !== "io client disconnect" && reason !== "io server disconnect") setOffline(true);
      if (reason !== "io server disconnect" || Date.now() - lastRenew.current < RENEW_INTERVAL_MS) return;
      lastRenew.current = Date.now();
      void queryClient.refetchQueries({ queryKey: SESSION_KEY });
    });
    return () => {
      socket.disconnect();
    };
  }, [token, queryClient]);

  return offline;
}
