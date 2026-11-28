import type { MetadataRoute } from "next";
import { allPosts, pendingPlaceholders } from "@/lib/blog/posts";
import { SITE_PAGES, SITE_URL } from "@/lib/site";

/** Páginas do site institucional e do blog. O painel fica de fora: é tudo atrás de login. */
export default function sitemap(): MetadataRoute.Sitemap {
  // Artigo com algo a preencher ou conferir fica fora até o texto final (a página também sai com noindex).
  const posts = allPosts().filter((post) => pendingPlaceholders(post).length === 0);
  const latest = posts[0];
  return [
    ...SITE_PAGES.map((path) => ({ url: `${SITE_URL}${path}` })),
    {
      url: `${SITE_URL}/blog`,
      ...(latest ? { lastModified: latest.updatedAt ?? latest.publishedAt } : {}),
    },
    ...posts.map((post) => ({ url: `${SITE_URL}/blog/${post.slug}`, lastModified: post.updatedAt ?? post.publishedAt })),
  ];
}
