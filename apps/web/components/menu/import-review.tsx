"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { count } from "@/lib/format";
import { type ImportPreview, type ImportRow } from "@/lib/menu-import";
import { money } from "@/lib/menu";
import { cn } from "@/lib/utils";

const priceText = (row: ImportRow) => {
  if (row.size) return `${row.size}: ${row.sizePriceCents === null ? "—" : money(row.sizePriceCents)}`;
  return row.priceCents === null ? "—" : money(row.priceCents);
};

/** Passo 2: resumo do que será criado e a tabela de revisão, com o que corrigir em cada linha. */
export function ImportReview({
  preview,
  fileName,
  onRestart,
  onTemplate,
}: {
  preview: ImportPreview;
  fileName: string;
  onRestart: () => void;
  onTemplate: () => void;
}) {
  const [filter, setFilter] = useState<"all" | "errors">("all");
  const { counts, rows } = preview;
  const shown = filter === "errors" ? rows.filter((row) => row.errors.length > 0) : rows;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-rule bg-surface p-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="mr-auto min-w-0">
          <div className="font-heading text-xl font-semibold tabular-nums">
            {count(counts.validRows)} de {count(counts.rows)} <span className="text-body font-normal text-ink-2">linhas prontas para importar</span>
          </div>
          <div className="truncate text-ink-3">{fileName}</div>
          <div className="text-ink-2 tabular-nums">
            Será criado: {count(counts.categories)} {counts.categories === 1 ? "categoria nova" : "categorias novas"}, {count(counts.items)}{" "}
            {counts.items === 1 ? "item" : "itens"} e {count(counts.sizes)} {counts.sizes === 1 ? "tamanho" : "tamanhos"}.
          </div>
        </div>
        <Button variant="ghost" onClick={onTemplate}>
          Baixar o modelo
        </Button>
        <Button variant="outline" onClick={onRestart}>
          Enviar outro arquivo
        </Button>
      </div>

      <div className="flex gap-2" role="group" aria-label="Filtro das linhas">
        {(
          [
            ["all", `Todas · ${count(counts.rows)}`],
            ["errors", `Com erro · ${count(counts.invalidRows)}`],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={filter === value ? "default" : "outline"}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </Button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-rule">
        <table className="w-full text-left tabular-nums">
          <thead className="bg-surface-2 text-xs text-ink-3">
            <tr>
              {["Linha", "Item", "Categoria", "Preço", "O que corrigir"].map((title) => (
                <th key={title} className="px-3 py-2 font-medium">
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-ink-3">
                  Nenhuma linha com erro.
                </td>
              </tr>
            )}
            {shown.map((row) => (
              <tr key={row.line} className={cn("border-t border-rule align-top", row.errors.length > 0 && "bg-tomate-lt")}>
                <td className="px-3 py-2 text-ink-3">{row.line}</td>
                <td className="px-3 py-2 font-medium">{row.item || "—"}</td>
                <td className="px-3 py-2 text-ink-2">{row.category || "—"}</td>
                <td className="px-3 py-2">{priceText(row)}</td>
                <td className="px-3 py-2 text-tomate-ink">
                  {row.errors.length === 0 ? <span className="text-success-ink">Pronta</span> : row.errors.map((error) => <div key={error}>{error}</div>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {counts.invalidRows > 0 && <p className="text-ink-2">As linhas com erro ficam de fora. Corrija a planilha e envie de novo, ou importe só as prontas.</p>}
    </section>
  );
}
