import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { PRIVATE_PATHS, SITE_PAGES, SITE_URL } from "./site";

/** HTML estático de cada página do site institucional (servido pelos rewrites do next.config). */
function staticHtml(path: string): string {
  const file = path === "/" ? "index.html" : `${path.slice(1)}/index.html`;
  return readFileSync(fileURLToPath(new URL(`../public/${file}`, import.meta.url)), "utf8");
}

describe("SEO do site institucional", () => {
  it("cada página do sitemap tem canonical, Open Graph e indexação liberada", () => {
    for (const path of SITE_PAGES) {
      const html = staticHtml(path);
      expect(html).toContain(`<link rel="canonical" href="${SITE_URL}${path}">`);
      expect(html).toContain(`<meta property="og:url" content="${SITE_URL}${path}">`);
      expect(html).toContain(`<meta property="og:image" content="${SITE_URL}/og-image.png">`);
      expect(html).not.toMatch(/<meta name="robots" content="[^"]*noindex/);
    }
  });

  it("a página inicial tem dados estruturados válidos", () => {
    const match = staticHtml("/").match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    const data = JSON.parse(match?.[1] ?? "{}") as { "@graph"?: { "@type": string }[] };
    const types = (data["@graph"] ?? []).map((node) => node["@type"]);
    expect(types).toEqual(expect.arrayContaining(["Organization", "WebSite", "SoftwareApplication", "FAQPage"]));
  });

  it("a página da extensão, que tem noindex, fica fora do sitemap", () => {
    expect(staticHtml("/extensao")).toContain('<meta name="robots" content="noindex">');
    expect(sitemap().map((entry) => entry.url)).not.toContain(`${SITE_URL}/extensao`);
  });

  it("o robots.txt fecha o painel e deixa o site, o blog e o cardápio público abertos", () => {
    const rules = robots().rules;
    const disallow = (Array.isArray(rules) ? rules[0] : rules)?.disallow;
    expect(disallow).toEqual(PRIVATE_PATHS);
    for (const open of ["/", "/funcionalidades", "/blog", "/c/"]) {
      expect(PRIVATE_PATHS.some((path) => open.startsWith(path) && path !== "/")).toBe(false);
    }
  });
});
