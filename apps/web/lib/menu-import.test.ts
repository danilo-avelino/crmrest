import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aiFileProblem, type AiImportRow, applySuggestion, decodeCsv, editRow, fileProblem, needsReview, TEMPLATE_CSV, validRows } from "@/lib/menu-import";

describe("importação do cardápio (cliente)", () => {
  it("o modelo para baixar é o mesmo de docs/cardapio-ia", () => {
    const doc = readFileSync("../../docs/cardapio-ia/modelo-cardapio.csv", "utf8");
    expect(TEMPLATE_CSV.replace(/\r\n/g, "\n")).toBe(doc.replace(/\r\n/g, "\n"));
  });

  it("lê UTF-8 e, se inválido, Windows-1252", () => {
    expect(decodeCsv(new TextEncoder().encode("Média").buffer)).toBe("Média");
    expect(decodeCsv(new Uint8Array([0x4d, 0xe9, 0x64, 0x69, 0x61]).buffer)).toBe("Média");
  });

  it("recusa arquivo vazio, grande ou de outro tipo", () => {
    expect(fileProblem({ name: "a.csv", size: 10 })).toBeNull();
    expect(fileProblem({ name: "a.csv", size: 0 })).toMatch(/vazio/);
    expect(fileProblem({ name: "a.csv", size: 2_000_000 })).toMatch(/1 MB/);
    expect(fileProblem({ name: "a.xlsx", size: 10 })).toMatch(/CSV/);
  });

  it("só as linhas sem erro vão para o commit", () => {
    expect(validRows([{ errors: [] }, { errors: ["x"] }] as never)).toHaveLength(1);
  });

  it("foto/PDF: tipo e tamanho antes de enviar", () => {
    expect(aiFileProblem({ name: "a.png", size: 10, type: "image/png" })).toBeNull();
    expect(aiFileProblem({ name: "a.pdf", size: 9 * 1024 * 1024, type: "application/pdf" })).toBeNull();
    expect(aiFileProblem({ name: "a.png", size: 6 * 1024 * 1024, type: "image/png" })).toMatch(/5 MB/);
    expect(aiFileProblem({ name: "a.gif", size: 10, type: "image/gif" })).toMatch(/PDF/);
  });

  it("foto/PDF: usar a sugestão ou editar o campo tira a dúvida dele", () => {
    const row = {
      line: 1, category: "Pizzas", item: "Portugeusa", description: null, priceCents: null, size: null, sizePriceCents: null,
      ingredients: [], allergens: [], servesPeople: null, tags: [], synonyms: [], errors: [],
      ai: { page: 1, lowConfidence: ["item", "price"], note: "Confira", suggestions: [{ field: "item", value: "Portuguesa" }] },
    } as AiImportRow;
    expect(needsReview(row)).toBe(true);
    const fixed = applySuggestion(row, row.ai.suggestions[0]!);
    expect(fixed).toMatchObject({ item: "Portuguesa", ai: { lowConfidence: ["price"], suggestions: [] } });
    const priced = editRow(fixed, "price", { priceCents: 3690 });
    expect(priced.priceCents).toBe(3690);
    expect(needsReview(priced)).toBe(false);
  });
});
