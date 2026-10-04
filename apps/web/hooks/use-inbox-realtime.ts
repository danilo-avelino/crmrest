"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { io } from "socket.io-client";
import { useAuth } from "@/components/auth/auth-provider";

const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL ?? "http://localhost:4000";

/** Conecta ao realtime da API; cada aviso faz o painel buscar de novo o que mudou. */
export function useInboxRealtime(): void {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const token = session?.accessToken;

  useEffect(() => {
    if (!token) return;
    const socket = io(REALTIME_URL, { auth: { token }, transports: ["websocket"] });
    socket.on("inbox.changed", ({ conversationId }: { conversationId: string }) => {
      for (const queryKey of [["conversations"], ["counts"], ["conversation", conversationId], ["messages", conversationId], ["contact"]]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    });
    return () => {
      socket.disconnect();
    };
  }, [token, queryClient]);
}
