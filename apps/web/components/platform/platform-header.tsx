import { LoaderCircleIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Cabeçalho das páginas da plataforma, no padrão de Configurações e Avaliações. */
export function PlatformHeader({ title }: { title: string }) {
  return (
    <header className="shrink-0 border-b border-rule-soft px-7 pt-5 pb-4">
      <h1 className="mb-[3px] font-heading text-[21px] leading-tight font-bold tracking-[-0.3px]">{title}</h1>
      <span className="text-xs text-ink-3">Painel da plataforma · Super Admin</span>
    </header>
  );
}

/** Carregamento (ou falha) de uma página da plataforma. */
export function PlatformLoading({ failed }: { failed: boolean }) {
  return (
    <div className="flex items-center gap-2 text-ink-3" aria-busy={!failed}>
      {failed ? (
        "Não foi possível carregar."
      ) : (
        <>
          <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
          Carregando…
        </>
      )}
    </div>
  );
}

/** Casco das páginas de lista da plataforma: cabeçalho e uma coluna de 760px que rola. */
export function PlatformPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface">
      <PlatformHeader title={title} />
      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="max-w-[760px]">{children}</div>
      </div>
    </main>
  );
}
