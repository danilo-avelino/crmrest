import { LoaderCircleIcon } from "lucide-react";

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
