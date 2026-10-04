"use client";

import { LoaderCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { useAuth } from "@/components/auth/auth-provider";

/** Só mostra o conteúdo com sessão e restaurante escolhidos; senão volta para o login. */
export function RequireContext({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const router = useRouter();
  const ready = !loading && Boolean(session?.context);

  useEffect(() => {
    if (!loading && !session?.context) router.replace("/login");
  }, [loading, session, router]);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-ink-3" aria-busy>
        <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
        Carregando…
      </div>
    );
  }
  return children;
}
