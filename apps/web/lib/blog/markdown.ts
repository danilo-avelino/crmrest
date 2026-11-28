/**
 * Markdown do blog: só o que os artigos usam, sem dependência nova.
 * - "## " e "### " viram títulos (com id para o índice da página);
 * - "- " e "1. " viram listas; "> " vira um quadro de destaque;
 * - **negrito**, [texto](endereço) e marcações {{PREENCHER: ...}} / {{CONFERIR: ...}} dentro do texto.
 * O resultado é uma árvore, renderizada como React: nada de HTML montado à mão.
 */

export type Inline =
  | { type: "text"; value: string }
  | { type: "strong"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "placeholder"; kind: "PREENCHER" | "CONFERIR"; value: string };

export type Block =
  | { type: "heading"; level: 2 | 3; id: string; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "callout"; paragraphs: Inline[][] };

/** Marcação do que o autor ainda precisa preencher ou conferir antes de publicar. */
export const PLACEHOLDER_RE = /\{\{(PREENCHER|CONFERIR):\s*([^}]+?)\s*\}\}/g;

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const INLINE_RE = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|\{\{(PREENCHER|CONFERIR):\s*([^}]+?)\s*\}\}/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ type: "text", value: text.slice(last, index) });
    const [whole, strong, label, href, kind, note] = match;
    if (strong !== undefined) out.push({ type: "strong", children: parseInline(strong) });
    else if (label !== undefined && href !== undefined) out.push({ type: "link", href, children: parseInline(label) });
    else out.push({ type: "placeholder", kind: kind === "CONFERIR" ? "CONFERIR" : "PREENCHER", value: note ?? "" });
    last = index + whole.length;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

/** Texto puro de uma linha (sem marcações), para ids e para contar palavras. */
export function plainText(inlines: Inline[]): string {
  return inlines
    .map((node) => (node.type === "text" ? node.value : node.type === "placeholder" ? node.value : plainText(node.children)))
    .join("");
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const usedIds = new Set<string>();
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const raw = (n: number) => lines[n] ?? "";
  let i = 0;

  const uniqueId = (text: string) => {
    const base = slugify(text) || "secao";
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    return id;
  };

  while (i < lines.length) {
    const line = raw(i).trim();
    if (!line) {
      i++;
      continue;
    }

    const heading = /^(#{2,3})\s+(.+)$/.exec(line);
    if (heading) {
      const [, hashes = "##", text = ""] = heading;
      const children = parseInline(text);
      blocks.push({ type: "heading", level: hashes.length === 3 ? 3 : 2, id: uniqueId(plainText(children)), children });
      i++;
      continue;
    }

    if (line.startsWith(">")) {
      const paragraphs: string[][] = [];
      let current: string[] = [];
      while (i < lines.length && raw(i).trim().startsWith(">")) {
        const content = raw(i).trim().replace(/^>\s?/, "");
        if (content) current.push(content);
        else if (current.length) {
          paragraphs.push(current);
          current = [];
        }
        i++;
      }
      if (current.length) paragraphs.push(current);
      blocks.push({
        type: "callout",
        paragraphs: paragraphs.map((p) => parseInline(p.join(" "))),
      });
      continue;
    }

    const listMatch = /^(-|\d+\.)\s+/.exec(line);
    if (listMatch) {
      const ordered = listMatch[1] !== "-";
      const itemRe = ordered ? /^\d+\.\s+/ : /^-\s+/;
      const items: string[] = [];
      while (i < lines.length) {
        const current = raw(i).trim();
        if (itemRe.test(current)) items.push(current.replace(itemRe, ""));
        else if (current && items.length && /^\s+/.test(raw(i))) items.push(`${items.pop() ?? ""} ${current}`);
        else break;
        i++;
      }
      blocks.push({ type: "list", ordered, items: items.map(parseInline) });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = raw(i).trim();
      if (!current || /^(#{2,3}\s|>|-\s|\d+\.\s)/.test(current)) break;
      paragraph.push(current);
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join(" ")) });
  }

  return blocks;
}
