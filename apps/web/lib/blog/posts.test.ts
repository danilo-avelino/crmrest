import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { parseMarkdown, type Inline } from "./markdown";
import { SITE_URL, allPosts, getPost, pendingPlaceholders } from "./posts";

const PILAR = "operacao-de-delivery";

function links(nodes: Inline[]): string[] {
  return nodes.flatMap((node) =>
    node.type === "link" ? [node.href, ...links(node.children)] : node.type === "strong" ? links(node.children) : [],
  );
}

function bodyLinks(body: string): string[] {
  return parseMarkdown(body).flatMap((block) =>
    block.type === "list"
      ? block.items.flatMap(links)
      : block.type === "callout"
        ? block.paragraphs.flatMap(links)
        : links(block.children),
  );
}

describe("artigos do blog", () => {
  const posts = allPosts();

  it("têm endereço único e datas válidas", () => {
    expect(new Set(posts.map((p) => p.slug)).size).toBe(posts.length);
    for (const post of posts) {
      expect(post.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(post.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (post.updatedAt) expect(post.updatedAt >= post.publishedAt).toBe(true);
    }
  });

  it("cabem no resultado do Google", () => {
    for (const post of posts) {
      expect((post.seoTitle ?? post.title).length, post.slug).toBeLessThanOrEqual(60);
      expect(post.description.length, post.slug).toBeLessThanOrEqual(160);
      expect(post.faq.length, post.slug).toBeGreaterThan(0);
    }
  });

  it("só linkam para artigos e seções que existem", () => {
    for (const post of posts) {
      for (const href of bodyLinks(post.body).filter((h) => h.startsWith("/blog/"))) {
        const [path = "", hash] = href.split("#");
        const target = getPost(path.replace("/blog/", ""));
        expect(target, `${post.slug} → ${href}`).toBeDefined();
        if (hash && target) {
          const ids = parseMarkdown(target.body).flatMap((b) => (b.type === "heading" ? [b.id] : []));
          expect(ids, `${post.slug} → ${href}`).toContain(hash);
        }
      }
      for (const slug of post.related) expect(getPost(slug), `${post.slug} → ${slug}`).toBeDefined();
    }
  });

  it("todo artigo leva para a página pilar", () => {
    for (const post of posts.filter((p) => p.slug !== PILAR)) {
      expect(bodyLinks(post.body).some((h) => h.startsWith(`/blog/${PILAR}`)), post.slug).toBe(true);
    }
  });

  it("acha o que falta preencher", () => {
    const base = getPost(PILAR);
    if (!base) throw new Error("pilar sumiu");
    const post = { ...base, title: "T", description: "D", body: "Texto {{PREENCHER: pedidos por mês}} e {{CONFERIR: regra}}.", faq: [] };
    expect(pendingPlaceholders(post)).toEqual(["PREENCHER: pedidos por mês", "CONFERIR: regra"]);
  });
});

describe("sitemap e robots", () => {
  it("lista o site e só os artigos prontos", () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toContain(`${SITE_URL}/`);
    expect(urls).toContain(`${SITE_URL}/blog`);
    for (const post of allPosts()) {
      expect(urls.includes(`${SITE_URL}/blog/${post.slug}`)).toBe(pendingPlaceholders(post).length === 0);
    }
  });

  it("aponta para o sitemap", () => {
    expect(robots().sitemap).toBe(`${SITE_URL}/sitemap.xml`);
  });
});
