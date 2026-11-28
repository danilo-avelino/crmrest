import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/blog/markdown";
import { BlogCta, JsonLd } from "@/components/blog/site-chrome";
import { parseMarkdown, plainText } from "@/lib/blog/markdown";
import {
  BLOG_NAME,
  SITE_URL,
  allPosts,
  formatPostDate,
  getPost,
  pendingPlaceholders,
  postUrl,
  readingMinutes,
} from "@/lib/blog/posts";

// Só os artigos do repositório: qualquer outro endereço em /blog/ é 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return allPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: PageProps<"/blog/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};
  const url = postUrl(post.slug);
  const title = `${post.seoTitle ?? post.title} | Dish Desk`;
  // Artigo com algo a preencher ou conferir não entra no Google até o texto final.
  const ready = pendingPlaceholders(post).length === 0;
  return {
    title,
    description: post.description,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      locale: "pt_BR",
      siteName: "Dish Desk",
      url,
      title: post.seoTitle ?? post.title,
      description: post.description,
      publishedTime: post.publishedAt,
      modifiedTime: post.updatedAt ?? post.publishedAt,
    },
    robots: ready ? { index: true, follow: true } : { index: false, follow: true },
  };
}

export default async function BlogPostPage({ params }: PageProps<"/blog/[slug]">) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  const url = postUrl(post.slug);
  const sections = parseMarkdown(post.body).flatMap((block) =>
    block.type === "heading" && block.level === 2 ? [{ id: block.id, label: plainText(block.children) }] : [],
  );
  const related = post.related.map(getPost).filter((item) => item !== undefined);

  return (
    <main>
      <JsonLd
        data={[
          {
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            headline: post.title,
            description: post.description,
            url,
            mainEntityOfPage: { "@type": "WebPage", "@id": url },
            datePublished: post.publishedAt,
            dateModified: post.updatedAt ?? post.publishedAt,
            inLanguage: "pt-BR",
            articleSection: post.topic,
            author: { "@type": "Organization", name: "Dish Desk", url: SITE_URL },
            publisher: { "@type": "Organization", name: "Dish Desk", url: SITE_URL },
            isPartOf: { "@type": "Blog", name: BLOG_NAME, url: `${SITE_URL}/blog` },
          },
          {
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: post.faq.map((item) => ({
              "@type": "Question",
              name: item.question,
              acceptedAnswer: { "@type": "Answer", text: item.answer },
            })),
          },
          {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "Início", item: `${SITE_URL}/` },
              { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE_URL}/blog` },
              { "@type": "ListItem", position: 3, name: post.title, item: url },
            ],
          },
        ]}
      />

      <header className="bg-[#1A1814] text-[#F7F4EF]">
        <div className="mx-auto max-w-[760px] px-6 pt-12 pb-12">
          <nav aria-label="Você está em" className="text-[13px] text-[#A2968A]">
            <a href="/blog" className="text-[#CFC6BB] no-underline hover:text-tomate">
              Blog
            </a>
            <span aria-hidden> / </span>
            <span>{post.topic}</span>
          </nav>
          <h1 className="mt-4 mb-0 font-heading text-[clamp(30px,4.2vw,46px)] leading-[1.08] font-bold tracking-[-0.8px]">
            {post.title}
          </h1>
          <p className="mt-4 mb-0 text-[17px] text-[#CFC6BB]">{post.description}</p>
          <p className="mt-5 mb-0 text-[13px] text-[#A2968A] tabular-nums">
            {post.updatedAt ? `Atualizado em ${formatPostDate(post.updatedAt)}` : formatPostDate(post.publishedAt)} ·{" "}
            {readingMinutes(post)} min de leitura
          </p>
        </div>
      </header>

      <article className="mx-auto max-w-[760px] px-6 pt-10 pb-6 text-[17px] leading-[1.7] text-ink-2">
        {sections.length > 2 && (
          <nav aria-label="Nesta página" className="mb-8 rounded-xl border border-rule bg-surface px-5 py-4 text-[15px]">
            <p className="m-0 text-[13px] font-semibold text-ink">Nesta página</p>
            <ol className="mt-2 mb-0 list-decimal space-y-1 pl-5 marker:text-ink-3">
              {sections.map((section) => (
                <li key={section.id}>
                  <a href={`#${section.id}`} className="text-ink-2 no-underline hover:text-tomate">
                    {section.label}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        )}

        <Markdown source={post.body} />

        {post.faq.length > 0 && (
          <section aria-labelledby="perguntas-frequentes">
            <h2
              id="perguntas-frequentes"
              className="mt-12 mb-4 scroll-mt-24 font-heading text-[26px] leading-tight font-bold tracking-tight text-ink"
            >
              Perguntas frequentes
            </h2>
            <dl className="m-0">
              {post.faq.map((item) => (
                <div key={item.question} className="border-t border-rule py-4">
                  <dt className="font-semibold text-ink">{item.question}</dt>
                  <dd className="mt-1 ml-0">{item.answer}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </article>

      <div className="mx-auto max-w-[760px] px-6 pt-4 pb-10">
        <BlogCta title={post.cta.title} text={post.cta.text} />
      </div>

      {related.length > 0 && (
        <section aria-labelledby="leia-tambem" className="mx-auto max-w-[760px] px-6 pb-16">
          <h2 id="leia-tambem" className="m-0 font-heading text-[20px] font-semibold text-ink">
            Leia também
          </h2>
          <ul className="mt-4 mb-0 grid list-none gap-3 p-0 sm:grid-cols-2">
            {related.map((item) => (
              <li key={item.slug}>
                <a
                  href={`/blog/${item.slug}`}
                  className="flex h-full flex-col rounded-xl border border-rule bg-surface p-5 text-ink no-underline transition hover:border-ink-3"
                >
                  <span className="text-[13px] font-medium text-tomate">{item.topic}</span>
                  <span className="mt-1.5 font-heading text-[17px] leading-snug font-semibold">{item.title}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
