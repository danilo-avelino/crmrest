/** Um artigo do blog. O corpo é Markdown (ver lib/blog/markdown.ts). */
export interface BlogPost {
  slug: string;
  /** Título da página (h1). */
  title: string;
  /** Título para o Google, se for diferente do h1. Até uns 60 caracteres. */
  seoTitle?: string;
  /** Meta description: a resposta curta, até uns 155 caracteres. */
  description: string;
  /** Galho do mapa do assunto, mostrado acima do título. */
  topic: string;
  /** AAAA-MM-DD */
  publishedAt: string;
  updatedAt?: string;
  body: string;
  faq: { question: string; answer: string }[];
  /** Slugs de outros artigos, mostrados no fim como leitura seguinte. */
  related: string[];
  /** Chamada para o Dish Desk no fim do artigo, ligada ao problema do texto. */
  cta: { title: string; text: string };
}
