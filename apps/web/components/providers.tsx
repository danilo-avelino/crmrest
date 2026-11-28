"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { AuthProvider } from "@/components/auth/auth-provider";
import { IfoodWidget } from "@/components/ifood-widget";
import { ToastProvider } from "@/components/ui/toast";
import { watchSystemTheme } from "@/lib/theme";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } }));
  useEffect(() => watchSystemTheme(), []);
  // Cardápio público (/c/...) e blog do site: sem login do painel, sem busca de sessão e sem o widget do iFood.
  const pathname = usePathname();
  if (pathname?.startsWith("/c/") || pathname === "/blog" || pathname?.startsWith("/blog/")) return <>{children}</>;
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>{children}</ToastProvider>
        <IfoodWidget />
      </AuthProvider>
    </QueryClientProvider>
  );
}
