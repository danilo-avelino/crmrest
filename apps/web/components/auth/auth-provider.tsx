"use client";

import type { AuthSession, SelectContextRequest } from "@comanda/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { ApiError, apiRequest } from "@/lib/api";

type AuthValue = {
  /** null depois de carregar = sem sessão. */
  session: AuthSession | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  selectContext(request: SelectContextRequest): Promise<void>;
  logout(): Promise<void>;
  /** Volta para a escolha de restaurante sem sair da conta. */
  switchContext(): void;
  /** Chamada autenticada à API; renova o access token uma vez se ele tiver expirado. */
  request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
};

const SESSION_KEY = ["auth", "session"] as const;

/** A sessão sobrevive ao reload pelo cookie httpOnly; o access token fica só em memória (cache da query). */
async function fetchSession(): Promise<AuthSession | null> {
  try {
    return await apiRequest<AuthSession>("/auth/refresh", { method: "POST" });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data: session = null, isPending } = useQuery({
    queryKey: SESSION_KEY,
    queryFn: fetchSession,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    // O access token vale 15 min: renova antes, para a API e o realtime não ficarem sem token.
    refetchInterval: 12 * 60_000,
  });

  const value = useMemo<AuthValue>(() => {
    const setSession = (next: AuthSession | null) => {
      // Dados de outro usuário ou restaurante nunca podem aparecer depois da troca.
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_KEY[0] });
      queryClient.setQueryData(SESSION_KEY, next);
    };
    const token = () => queryClient.getQueryData<AuthSession | null>(SESSION_KEY)?.accessToken ?? null;

    return {
      session,
      loading: isPending,
      async login(email, password) {
        setSession(await apiRequest<AuthSession>("/auth/login", { method: "POST", body: { email, password } }));
      },
      async selectContext(request) {
        setSession(await apiRequest<AuthSession>("/auth/context", { method: "POST", body: request }));
      },
      async logout() {
        await apiRequest("/auth/logout", { method: "POST" });
        setSession(null);
      },
      switchContext() {
        if (session) setSession({ ...session, context: null, accessToken: null });
      },
      async request<T>(path: string, init: { method?: string; body?: unknown } = {}) {
        try {
          return await apiRequest<T>(path, { ...init, token: token() });
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 401) throw error;
          const renewed = await fetchSession();
          queryClient.setQueryData(SESSION_KEY, renewed);
          if (!renewed?.accessToken) throw error;
          return apiRequest<T>(path, { ...init, token: renewed.accessToken });
        }
      },
    };
  }, [session, isPending, queryClient]);

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth precisa estar dentro de <AuthProvider>");
  return value;
}
