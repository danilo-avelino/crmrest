import { CheckIcon } from "lucide-react";

/** Painel direito (escuro) das telas de cadastro e de assinatura, no padrão do board "Login · Escolha de restaurante". */
export function AuthAside({ title, subtitle, items }: { title: string; subtitle: string; items: string[] }) {
  return (
    <section className="relative flex flex-1 flex-col overflow-hidden bg-ink">
      {/* Textura de comanda: linhas sutis a cada 32px. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(0deg,transparent,transparent_31px,rgba(247,244,239,0.03)_31px,rgba(247,244,239,0.03)_32px)]"
      />
      <div className="relative flex flex-1 flex-col items-center justify-center p-16">
        <h2 className="mb-1.5 text-center font-heading text-[21px] font-semibold tracking-[-0.3px] text-paper">{title}</h2>
        <p className="mb-7 text-center text-[13px] text-[#5C5750]">{subtitle}</p>
        <ul className="flex w-full max-w-[380px] flex-col gap-1.5">
          {items.map((item) => (
            <li key={item} className="flex items-center gap-3 rounded-xl border border-[#2A2720] px-4 py-[13px] text-[14px] text-[#C0B8B0]">
              <CheckIcon className="size-3.5 shrink-0 text-success" aria-hidden />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
