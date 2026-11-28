import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, slugify } from "./markdown";

describe("slugify", () => {
  it("tira acentos e pontuação", () => {
    expect(slugify("Avaliações: o que fazer quando a nota cai?")).toBe("avaliacoes-o-que-fazer-quando-a-nota-cai");
  });
});

describe("parseInline", () => {
  it("lê negrito, link e marcação para preencher", () => {
    expect(parseInline("a **b** [c](/blog/x) {{PREENCHER: número}}")).toEqual([
      { type: "text", value: "a " },
      { type: "strong", children: [{ type: "text", value: "b" }] },
      { type: "text", value: " " },
      { type: "link", href: "/blog/x", children: [{ type: "text", value: "c" }] },
      { type: "text", value: " " },
      { type: "placeholder", kind: "PREENCHER", value: "número" },
    ]);
  });
});

describe("parseMarkdown", () => {
  it("monta títulos com id único, parágrafos, listas e destaque", () => {
    const blocks = parseMarkdown(
      [
        "Primeira linha",
        "continua.",
        "",
        "## Por quê?",
        "",
        "- um",
        "- dois",
        "",
        "1. **Passo:** faça",
        "2. outro",
        "",
        "> **Na nossa operação**",
        ">",
        "> Texto.",
        "",
        "## Por quê?",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "heading", "list", "list", "callout", "heading"]);
    expect(blocks[0]).toEqual({ type: "paragraph", children: [{ type: "text", value: "Primeira linha continua." }] });
    expect(blocks[1]).toMatchObject({ level: 2, id: "por-que" });
    expect(blocks[5]).toMatchObject({ id: "por-que-2" });
    expect(blocks[2]).toMatchObject({ ordered: false, items: [[{ value: "um" }], [{ value: "dois" }]] });
    expect(blocks[3]).toMatchObject({ ordered: true });
    const callout = blocks[4];
    expect(callout?.type === "callout" && callout.paragraphs).toHaveLength(2);
  });
});
