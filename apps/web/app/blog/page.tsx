import type { Metadata } from "next";
import { BlogCta, JsonLd } from "@/components/blog/site-chrome";
import { BLOG_NAME, SITE_URL, allPosts, formatPostDate, pendingPlaceholders, readingMinutes } from "@/lib/blog/posts";

const DESCRIPTION =
  "Operação de delivery para donos de restaurante: atendimento nos apps e no WhatsApp, avaliações do iFood, tempo de despacho, cliente próprio e embalagem.";

export const metadata: Metadata = {
  title: `${BLOG_NAME}: operação de delivery para restaurantes`,
  description: DESCRIPTION,
  alternates: { canonical: `${SITE_URL}/blog` },
  openGraph: {
    type: "website",
    locale: "pt_BR",
    siteName: "Dish Desk",
    url: `${SITE_URL}/blog`,
    title: BLOG_NAME,
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export default function BlogIndexPage() {
  const posts = allPosts();
  return (
    <main>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Blog",
          name: BLOG_NAME,
          description: DESCRIPTION,
          url: `${SITE_URL}/blog`,
          inLanguage: "pt-BR",
          publisher: { "@type": "Organization", name: "Dish Desk", url: SITE_URL },
          blogPost: posts
            .filter((post) => pendingPlaceholders(post).length === 0)
            .map((post) => ({
              "@type": "BlogPosting",
              headline: post.title,
              url: `${SITE_URL}/blog/${post.slug}`,
              datePublished: post.publishedAt,
            })),
        }}
      />
      <section className="bg-[#1A1814] text-[#F7F4EF]">
        <div className="mx-auto max-w-[1200px] px-6 pt-16 pb-14">
          <p className="m-0 text-sm font-medium text-[#CFC6BB]">{BLOG_NAME}</p>
          <h1 className="mt-3 mb-0 max-w-[820px] font-heading text-[clamp(34px,4.6vw,56px)] leading-[1.05] font-bold tracking-[-1.2px]">
            A operação de delivery, vista de <span className="text-tomate italic">dentro da cozinha.</span>
          </h1>
          <p className="mt-5 mb-0 max-w-[600px] text-[17px] text-[#CFC6BB]">
            Respostas diretas para o que o dono de restaurante enfrenta todo dia: atendimento, avaliações, tempo e o
            cliente que precisa voltar.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-6 py-12">
        <h2 className="sr-only">Artigos</h2>
        <ul className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {posts.map((post) => (
            <li key={post.slug}>
              <a
                href={`/blog/${post.slug}`}
                className="flex h-full flex-col rounded-xl border border-rule bg-surface p-6 text-ink no-underline transition hover:-translate-y-0.5 hover:border-ink-3"
              >
                <span className="text-[13px] font-medium text-tomate">{post.topic}</span>
                <span className="mt-2 font-heading text-[21px] leading-snug font-semibold">{post.title}</span>
                <span className="mt-3 flex-1 text-[14px] text-ink-2">{post.description}</span>
                <span className="mt-5 text-[13px] text-ink-3 tabular-nums">
                  {formatPostDate(post.publishedAt)} · {readingMinutes(post)} min de leitura
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <div className="mx-auto max-w-[1200px] px-6 pb-16">
        <BlogCta
          title="Atenda iFood, WhatsApp e Instagram num painel só"
          text="O Dish Desk junta as conversas dos canais numa caixa de entrada, com o pedido e o histórico do cliente ao lado, e uma IA que responde no tom do seu restaurante."
        />
      </div>
    </main>
  );
}
