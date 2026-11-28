import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Topo e rodapé do blog, iguais aos do site institucional (public/index.html).
 * Links com <a> para as páginas em HTML estático do site, que só abrem com carga completa.
 * Links fixos para /blog usam <Link>, como pede o lint do Next.
 */

const WHATSAPP = "https://wa.me/5586999731647?text=Ol%C3%A1!%20Quero%20conhecer%20o%20Dish%20Desk.";

function Mark() {
  return (
    <span className="flex size-[30px] items-center justify-center rounded-md bg-[#F7F4EF]">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <rect x="3" y="4" width="10" height="1.5" rx="0.75" fill="#1A1814" />
        <rect x="3" y="7.25" width="7" height="1.5" rx="0.75" fill="#1A1814" />
        <rect x="3" y="10.5" width="4.5" height="1.5" rx="0.75" fill="#C4341A" />
      </svg>
    </span>
  );
}

function NavLink({ href, current, children }: { href: string; current?: boolean; children: ReactNode }) {
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      className={
        current
          ? "border-b-2 border-tomate pb-0.5 text-[#F7F4EF] no-underline"
          : "text-[#CFC6BB] no-underline hover:text-tomate"
      }
    >
      {children}
    </a>
  );
}

export function BlogHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-[rgba(247,244,239,.08)] bg-[rgba(26,24,20,.9)] backdrop-blur-md">
      <nav aria-label="Principal" className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-6 px-6 py-3.5 text-[#F7F4EF]">
        <a href="/" className="flex items-center gap-2.5 text-[#F7F4EF] no-underline">
          <Mark />
          <span className="font-heading text-[19px] font-semibold">Dish Desk</span>
        </a>
        <div className="ml-4 hidden gap-6 text-sm font-medium md:flex">
          <NavLink href="/">Início</NavLink>
          <NavLink href="/funcionalidades">Funcionalidades</NavLink>
          <NavLink href="/blog" current>
            Blog
          </NavLink>
          <NavLink href="/#preco">Preço</NavLink>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <a href="/login" className="flex h-11 items-center px-3 text-sm font-medium text-[#F7F4EF] no-underline">
            Entrar
          </a>
          <a
            href="/cadastro"
            className="flex h-11 items-center rounded-lg bg-[#B02E17] px-[18px] text-sm font-medium text-white no-underline transition hover:bg-[#982612]"
          >
            Testar grátis
          </a>
        </div>
      </nav>
    </header>
  );
}

export function BlogFooter() {
  return (
    <footer className="bg-[#1A1814] text-[#A2968A]">
      <div className="mx-auto flex max-w-[1200px] flex-wrap gap-5 px-6 py-6 text-[13px]">
        <span>Dish Desk</span>
        <Link href="/blog" className="text-[#CFC6BB]">
          Blog
        </Link>
        <a href="/privacidade" className="text-[#CFC6BB]">
          Privacidade
        </a>
        <a href="/exclusao-de-dados" className="text-[#CFC6BB]">
          Exclusão de dados
        </a>
        <a href="/extensao" className="text-[#CFC6BB]">
          Extensão do Chrome
        </a>
        <a href={WHATSAPP} className="text-[#CFC6BB]">
          WhatsApp
        </a>
        <a href="/login" className="ml-auto text-[#CFC6BB]">
          Entrar
        </a>
      </div>
    </footer>
  );
}

/** Chamada para o Dish Desk no fim de cada artigo e no índice. */
export function BlogCta({ title, text }: { title: string; text: string }) {
  return (
    <section aria-label="Conheça o Dish Desk" className="rounded-2xl bg-[#1A1814] px-6 py-8 text-[#F7F4EF] sm:px-8">
      <h2 className="m-0 font-heading text-[24px] leading-tight font-bold tracking-tight">{title}</h2>
      <p className="mt-3 mb-0 max-w-[560px] text-[15px] text-[#CFC6BB]">{text}</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <a
          href="/demo"
          className="flex h-11 items-center rounded-lg bg-[#B02E17] px-[18px] text-sm font-medium text-white no-underline transition hover:bg-[#982612]"
        >
          Ver a demonstração
        </a>
        <a
          href="/cadastro"
          className="flex h-11 items-center rounded-lg border border-[rgba(247,244,239,.28)] px-[18px] text-sm font-medium text-[#F7F4EF] no-underline hover:border-[#F7F4EF]"
        >
          Testar grátis
        </a>
      </div>
    </section>
  );
}

/** Dados estruturados (schema.org). O "<" é escapado para o JSON não fechar a tag script. */
export function JsonLd({ data }: { data: object }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }} />;
}
