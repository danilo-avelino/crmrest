"use client";

import { Button } from "@/components/ui/button";

/** A API do cardápio não respondeu: texto em português e "Tentar de novo". */
export default function MenuError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="flex flex-1 flex-col items-center gap-3 px-6 pt-30 text-center">
      <h1 className="m-0 font-heading text-[22px] leading-tight font-bold">Não foi possível abrir o cardápio</h1>
      <p className="m-0 max-w-72.5 text-ink-2">Algo falhou do nosso lado. Tente de novo em instantes.</p>
      <Button size="lg" onClick={() => reset()}>
        Tentar de novo
      </Button>
    </main>
  );
}
