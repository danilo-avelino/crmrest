"use client";

import { LoaderCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { useAuth } from "@/components/auth/auth-provider";

function ContextLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center gap-2 text-ink-3" aria-busy>
      <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
      Carregando…
    </div>
  );
}

function hasAdminContext(session: ReturnType<typeof useAuth>["session"]): boolean {
  return Boolean(session?.context?.tenants.some((tenant) => tenant.role === "ADMIN"));
}

/** Só mostra o conteúdo com sessão e restaurante escolhidos; senão volta para o login. */
export function RequireContext({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const router = useRouter();
  const ready = !loading && Boolean(session?.context);

  useEffect(() => {
    if (!loading && !session?.context) router.replace("/login");
  }, [loading, session, router]);

  if (!ready) {
    return <ContextLoading />;
  }
  return children;
}

/** Páginas fora da Inbox: só administradores do restaurante. Atendentes voltam para a Inbox. */
export function RequireAdminContext({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const router = useRouter();
  const ready = !loading && Boolean(session?.context) && hasAdminContext(session);

  useEffect(() => {
    if (loading) return;
    if (!session?.context) router.replace("/login");
    else if (!hasAdminContext(session)) router.replace("/inbox");
  }, [loading, session, router]);

  if (!ready) {
    return <ContextLoading />;
  }
  return children;
}
