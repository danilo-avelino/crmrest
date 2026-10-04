"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import "./globals.css";

/** Erro que derrubou a página inteira (substitui o layout raiz): vai para o Sentry e a pessoa pode recarregar. */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="pt-BR">
      <body className="flex min-h-screen items-center justify-center bg-paper">
        <div className="text-center">
          <h1 className="font-heading text-title font-semibold text-ink">Algo deu errado</h1>
          <p className="mt-1 text-ink-3">Recarregue a página. Se o erro continuar, avise o suporte.</p>
          <Button variant="outline" className="mt-4" onClick={() => window.location.reload()}>
            Recarregar
          </Button>
        </div>
      </body>
    </html>
  );
}
