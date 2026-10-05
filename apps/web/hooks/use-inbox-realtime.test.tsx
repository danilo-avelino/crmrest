import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInboxRealtime } from "./use-inbox-realtime";

const handlers = new Map<string, (...args: unknown[]) => void>();
const socket = { on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler), disconnect: vi.fn() };
vi.mock("socket.io-client", () => ({ io: () => socket }));
vi.mock("@/components/auth/auth-provider", () => ({
  SESSION_KEY: ["auth", "session"],
  useAuth: () => ({ session: { accessToken: "token-1" } }),
}));

function setup() {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
  const refetch = vi.spyOn(queryClient, "refetchQueries").mockResolvedValue();
  const { result } = renderHook(() => useInboxRealtime(), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  const emit = (event: string, ...args: unknown[]) => act(() => handlers.get(event)!(...args));
  return { invalidate, refetch, emit, offline: () => result.current };
}

describe("realtime da Inbox", () => {
  beforeEach(() => handlers.clear());

  it("avisa enquanto a conexão estiver caída", () => {
    const { emit, offline } = setup();
    emit("connect");
    expect(offline()).toBe(false);
    emit("disconnect", "transport close");
    expect(offline()).toBe(true);
    emit("connect");
    expect(offline()).toBe(false);
    emit("connect_error", new Error("xhr poll error"));
    expect(offline()).toBe(true);
  });

  it("busca a Inbox de novo ao reconectar, não na primeira conexão", () => {
    const { invalidate, emit } = setup();
    emit("connect");
    expect(invalidate).not.toHaveBeenCalled();

    emit("connect"); // a API reiniciou: avisos podem ter se perdido
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["conversations"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["messages"] });
  });

  it("renova a sessão quando o servidor recusa o token, no máximo uma vez por minuto", () => {
    const { refetch, emit } = setup();
    emit("disconnect", "transport close"); // queda comum: o Socket.IO reconecta sozinho
    expect(refetch).not.toHaveBeenCalled();

    emit("disconnect", "io server disconnect");
    emit("disconnect", "io server disconnect");
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledWith({ queryKey: ["auth", "session"] });
  });
});
