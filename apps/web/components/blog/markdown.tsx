import { Fragment } from "react";
import { type Block, type Inline, parseMarkdown } from "@/lib/blog/markdown";

function Inlines({ nodes }: { nodes: Inline[] }) {
  return nodes.map((node, i) => {
    if (node.type === "text") return <Fragment key={i}>{node.value}</Fragment>;
    if (node.type === "strong")
      return (
        <strong key={i} className="font-semibold text-ink">
          <Inlines nodes={node.children} />
        </strong>
      );
    if (node.type === "link") {
      const external = /^https?:\/\//.test(node.href);
      return (
        <a
          key={i}
          href={node.href}
          className="font-medium text-tomate underline decoration-tomate/40 underline-offset-2 hover:decoration-tomate"
          {...(external ? { target: "_blank", rel: "noopener" } : {})}
        >
          <Inlines nodes={node.children} />
        </a>
      );
    }
    // Lembrete para o autor: aparece destacado e deixa a página fora do Google até ser trocado pelo texto final.
    return (
      <mark key={i} className="rounded-sm border border-dashed border-warning-line bg-warning-lt px-1 text-warning-ink">
        [{node.kind === "PREENCHER" ? "Preencher" : "Conferir"}: {node.value}]
      </mark>
    );
  });
}

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "heading":
      return block.level === 2 ? (
        <h2 id={block.id} className="mt-12 mb-4 scroll-mt-24 font-heading text-[26px] leading-tight font-bold tracking-tight text-ink">
          <Inlines nodes={block.children} />
        </h2>
      ) : (
        <h3 id={block.id} className="mt-8 mb-3 scroll-mt-24 font-heading text-[20px] leading-snug font-semibold text-ink">
          <Inlines nodes={block.children} />
        </h3>
      );
    case "paragraph":
      return (
        <p className="my-4">
          <Inlines nodes={block.children} />
        </p>
      );
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List className={`my-4 space-y-2 pl-6 ${block.ordered ? "list-decimal" : "list-disc"} marker:text-ink-3`}>
          {block.items.map((item, i) => (
            <li key={i} className="pl-1">
              <Inlines nodes={item} />
            </li>
          ))}
        </List>
      );
    }
    case "callout":
      return (
        <aside className="my-8 rounded-xl border border-rule border-l-4 border-l-tomate bg-surface px-5 py-4">
          {block.paragraphs.map((paragraph, i) => (
            <p key={i} className={i === 0 ? "m-0" : "mt-2 mb-0"}>
              <Inlines nodes={paragraph} />
            </p>
          ))}
        </aside>
      );
  }
}

/** Corpo do artigo, a partir do Markdown do post. */
export function Markdown({ source }: { source: string }) {
  return parseMarkdown(source).map((block, i) => <BlockView key={i} block={block} />);
}
