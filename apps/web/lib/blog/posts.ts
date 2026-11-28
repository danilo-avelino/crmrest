import { despachoPost } from "@/content/blog/tempo-de-preparo-x-tempo-de-despacho";
import { contestarAvaliacaoPost } from "@/content/blog/contestar-avaliacao-ifood";
import { pilarPost } from "@/content/blog/operacao-de-delivery";
import { PLACEHOLDER_RE, parseMarkdown, plainText } from "./markdown";
import type { BlogPost } from "./types";
import { SITE_URL } from "@/lib/site";

/** Domínio do site institucional e do painel. */
export { SITE_URL };

export const BLOG_NAME = "Blog do Dish Desk";

/** Ordem de publicação do plano: o pilar primeiro. Um artigo novo entra aqui. */
const POSTS: BlogPost[] = [pilarPost, despachoPost, contestarAvaliacaoPost];

/** Artigos, do mais novo para o mais antigo; na mesma data, vale a ordem de POSTS. */
export function allPosts(): BlogPost[] {
  return POSTS.map((post, order) => ({ post, order }))
    .sort((a, b) => b.post.publishedAt.localeCompare(a.post.publishedAt) || a.order - b.order)
    .map(({ post }) => post);
}

export function getPost(slug: string): BlogPost | undefined {
  return POSTS.find((post) => post.slug === slug);
}

export function postUrl(slug: string): string {
  return `${SITE_URL}/blog/${slug}`;
}

/** Tudo o que o autor marcou para preencher ou conferir. Enquanto houver algo, a página fica fora do Google. */
export function pendingPlaceholders(post: BlogPost): string[] {
  const texts = [post.title, post.description, post.body, ...post.faq.flatMap((item) => [item.question, item.answer])];
  return texts.flatMap((text) => [...text.matchAll(PLACEHOLDER_RE)].map((match) => `${match[1]}: ${match[2]}`));
}

export function readingMinutes(post: BlogPost): number {
  const words = parseMarkdown(post.body)
    .map((block) =>
      block.type === "list"
        ? block.items.map(plainText).join(" ")
        : block.type === "callout"
          ? block.paragraphs.map(plainText).join(" ")
          : plainText(block.children),
    )
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/** "28 de novembro de 2026" a partir de "2026-11-28", sem depender do fuso do servidor. */
export function formatPostDate(date: string): string {
  return new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`),
  );
}
