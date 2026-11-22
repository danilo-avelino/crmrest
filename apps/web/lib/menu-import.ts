/** Importação do cardápio por CSV (F2-09): tipos da API, modelo para baixar e helpers do arquivo. */

export type ImportRow = {
  line: number;
  category: string;
  item: string;
  description: string | null;
  priceCents: number | null;
  size: string | null;
  sizePriceCents: number | null;
  ingredients: string[];
  allergens: string[];
  servesPeople: number | null;
  tags: string[];
  synonyms: string[];
  errors: string[];
};

export type ImportPlanCategory = {
  name: string;
  existing: boolean;
  items: { name: string; priceCents: number | null; sizes: { name: string; priceCents: number }[] }[];
};
export type ImportCounts = { rows: number; validRows: number; invalidRows: number; categories: number; items: number; sizes: number };
export type ImportPreview = { rows: ImportRow[]; plan: ImportPlanCategory[]; counts: ImportCounts };
export type ImportResult = { categories: number; items: number; sizes: number };

export const IMPORT_MAX_BYTES = 1_000_000;

/** Igual a `docs/cardapio-ia/modelo-cardapio.csv` (o teste confere). */
export const TEMPLATE_CSV = `categoria;item;descricao;preco;tamanho;preco_tamanho;ingredientes;alergenos;serve_pessoas;tags;apelidos
Pizzas;Calabresa;Linguiça calabresa fatiada com cebola e azeitonas;;Média;49,90;"molho de tomate;mussarela;linguiça calabresa;cebola;azeitona";"glúten;lactose";2;mais pedido;"calabreza;linguiça"
Pizzas;Calabresa;;;Grande;62,90;;;3;;
Pizzas;Quatro Queijos;Mussarela, provolone, parmesão e gorgonzola;;Média;54,90;"mussarela;provolone;parmesão;gorgonzola";"glúten;lactose";2;vegetariano;4 queijos
Pizzas;Quatro Queijos;;;Grande;67,90;;;3;;
Bebidas;Coca-Cola 2L;Refrigerante gelado;R$ 14,00;;;;;;;"refri;coca"
Sobremesas;Petit Gâteau;Bolo quente de chocolate com sorvete de creme;32.50;;;"chocolate;farinha;ovo;sorvete de creme";"glúten;ovo;lactose";1;doce;
`;

/** Lê os bytes do arquivo: UTF-8 e, se não for válido (Excel antigo), Windows-1252. */
export function decodeCsv(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Confere o arquivo antes de enviar (a API confere de novo). */
export function fileProblem(file: { name: string; size: number }): string | null {
  if (file.size === 0) return `${file.name} está vazio.`;
  if (file.size > IMPORT_MAX_BYTES) return `${file.name} passa de 1 MB. Divida a planilha em partes.`;
  if (!/\.(csv|txt)$/i.test(file.name)) return `${file.name} não é um arquivo CSV. No Excel, use Salvar como > CSV UTF-8.`;
  return null;
}

/** Só as linhas sem erro vão para o commit. */
export const validRows = (rows: ImportRow[]) => rows.filter((row) => row.errors.length === 0);

/* Importação por foto/PDF com IA (F2-10): as mesmas linhas, com o que a IA marcou para conferir. */

export type AiField = "category" | "item" | "description" | "size" | "price";
export type AiTextField = Exclude<AiField, "price">;
export type AiImportRow = ImportRow & {
  ai: { page: number | null; lowConfidence: AiField[]; note: string | null; suggestions: { field: AiTextField; value: string }[] };
};
export type AiImportStatus =
  | { status: "reading"; progress: number; fileName: string; pages: number | null }
  | { status: "failed"; message: string; fileName: string }
  | ({ status: "done"; fileName: string; pages: number | null; mime: string; fileUrl: string | null } & Omit<ImportPreview, "rows"> & { rows: AiImportRow[] });

export const AI_MIMES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

/** Confere a foto ou o PDF antes de enviar (a API confere de novo, com as páginas). */
export function aiFileProblem(file: { name: string; size: number; type: string }): string | null {
  if (!AI_MIMES.includes(file.type)) return `${file.name} não é foto (JPG, PNG ou WEBP) nem PDF.`;
  if (file.size === 0) return `${file.name} está vazio.`;
  const pdf = file.type === "application/pdf";
  if (file.size > (pdf ? 10 : 5) * 1024 * 1024) return `${file.name} passa de ${pdf ? "10" : "5"} MB.`;
  return null;
}

/** Linha que pede atenção: campo lido com dúvida, sugestão pendente ou erro. */
export const needsReview = (row: AiImportRow) => row.ai.lowConfidence.length > 0 || row.ai.suggestions.length > 0 || row.errors.length > 0;

/** Usa a correção sugerida: troca o campo e tira a dúvida dele. */
export function applySuggestion(row: AiImportRow, suggestion: { field: AiTextField; value: string }): AiImportRow {
  return {
    ...row,
    [suggestion.field]: suggestion.value,
    ai: {
      ...row.ai,
      lowConfidence: row.ai.lowConfidence.filter((field) => field !== suggestion.field),
      suggestions: row.ai.suggestions.filter((entry) => entry !== suggestion),
    },
  };
}

/** Editar um campo à mão confirma a leitura dele. */
export function editRow(row: AiImportRow, field: AiField, patch: Partial<ImportRow>): AiImportRow {
  return {
    ...row,
    ...patch,
    ai: { ...row.ai, lowConfidence: row.ai.lowConfidence.filter((entry) => entry !== field), suggestions: row.ai.suggestions.filter((entry) => entry.field !== field) },
  };
}
