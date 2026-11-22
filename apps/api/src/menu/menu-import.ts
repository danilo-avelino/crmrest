/**
 * Importação do cardápio por planilha CSV (F2-09): leitura do arquivo, validação por linha e o plano do que será criado.
 * Tudo aqui é puro (sem banco): o serviço só confere o que já existe e grava.
 */

export const IMPORT_MAX_BYTES = 1_000_000;
export const IMPORT_MAX_ROWS = 2_000;

/** Uma linha já lida: o que será gravado e os problemas (em português) que a impedem. */
export type ImportRow = {
  line: number;
  category: string;
  item: string;
  description: string | null;
  priceCents: number | null; // preço do item (sem tamanho)
  size: string | null;
  sizePriceCents: number | null;
  ingredients: string[];
  allergens: string[];
  servesPeople: number | null;
  tags: string[];
  synonyms: string[];
  errors: string[];
};

export type ImportPlanItem = {
  name: string;
  description: string | null;
  priceCents: number | null;
  sizes: { name: string; priceCents: number }[];
  ingredients: string[];
  allergens: string[];
  servesPeople: number | null;
  tags: string[];
  synonyms: string[];
};
export type ImportPlanCategory = { name: string; existing: boolean; items: ImportPlanItem[] };
export type ImportCounts = { rows: number; validRows: number; invalidRows: number; categories: number; items: number; sizes: number };

/** Problema do arquivo inteiro (vazio, sem coluna obrigatória, grande demais): vira 400. */
export class ImportFileError extends Error {}

/** Lê o CSV em campos: aspas, aspas duplas escapadas, quebras de linha dentro de aspas, CRLF e BOM. Devolve a linha física de cada registro. */
export function parseCsv(text: string, delimiter: string): { line: number; cells: string[] }[] {
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;
  const endCell = () => {
    cells.push(cell);
    cell = "";
  };
  const endRecord = () => {
    endCell();
    if (cells.some((value) => value.trim() !== "")) records.push({ line: startLine, cells });
    cells = [];
  };
  const source = text.replace(/^﻿/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (char === "\n") line++;
        cell += char;
      }
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === delimiter) endCell();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      endRecord();
      line++;
      startLine = line;
    } else cell += char;
  }
  if (quoted) throw new ImportFileError("O arquivo tem aspas abertas e não fechadas.");
  endRecord();
  return records;
}

/** `;`, `,` ou tabulação: o que mais aparece na primeira linha, fora das aspas (empate: `;`). */
export function detectDelimiter(text: string): string {
  const first = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  const counts: Record<string, number> = { ";": 0, ",": 0, "\t": 0 };
  let quoted = false;
  for (const char of first) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char in counts) counts[char] = (counts[char] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] === ";" ? -1 : 1))[0]![0];
}

const normalizeHeader = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/** "49,90", "49.90", "R$ 49,90", "1.250,00" e "1,250.00" viram centavos; vazio é `null`, inválido é `NaN`. */
export function parsePriceCents(raw: string): number | null {
  const text = raw.replace(/R\$/gi, "").replace(/\s/g, "");
  if (text === "") return null;
  if (!/^\d[\d.,]*$/.test(text)) return Number.NaN;
  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? "," : ".";
    normalized = text.split(decimal === "," ? "." : ",").join("").replace(decimal, ".");
  } else if (lastComma >= 0 || lastDot >= 0) {
    const parts = text.split(lastComma >= 0 ? "," : ".");
    // "1.250" e "1.250.000" são milhar; "49.90", "49,9" e "0.500" são decimais.
    const thousands = parts.length > 2 || (parts[1]!.length === 3 && parts[0] !== "0");
    normalized = thousands ? parts.join("") : `${parts[0]}.${parts[1]}`;
  } else normalized = text;
  const value = Number(normalized);
  return Number.isFinite(value) ? Math.round(value * 100) : Number.NaN;
}

const list = (raw: string) => [...new Set(raw.split(";").map((part) => part.trim()).filter(Boolean))];

/** O texto do arquivo vira linhas; coluna obrigatória faltando derruba o arquivo (`ImportFileError`), erro de linha não. */
export function readMenuCsv(text: string): ImportRow[] {
  if (Buffer.byteLength(text) > IMPORT_MAX_BYTES) throw new ImportFileError("O arquivo passa de 1 MB.");
  const records = parseCsv(text, detectDelimiter(text));
  const header = records.shift();
  if (!header) throw new ImportFileError("O arquivo está vazio.");
  const index = new Map(header.cells.map((name, position) => [normalizeHeader(name), position]));
  const missing = ["categoria", "item"].filter((name) => !index.has(name));
  if (!index.has("preco") && !index.has("preco_tamanho")) missing.push("preco");
  if (missing.length) {
    throw new ImportFileError(`Faltam colunas na primeira linha: ${missing.join(", ")}. Baixe o modelo para ver o formato.`);
  }
  if (records.length === 0) throw new ImportFileError("O arquivo não tem nenhum item abaixo do cabeçalho.");
  if (records.length > IMPORT_MAX_ROWS) throw new ImportFileError(`O arquivo tem mais de ${IMPORT_MAX_ROWS} linhas. Divida em partes.`);

  return records.map(({ line, cells }) => {
    const get = (name: string) => (cells[index.get(name) ?? -1] ?? "").trim();
    const errors: string[] = [];
    const price = parsePriceCents(get("preco"));
    const sizePrice = parsePriceCents(get("preco_tamanho"));
    if (Number.isNaN(price)) errors.push(`Preço inválido: "${get("preco")}".`);
    if (Number.isNaN(sizePrice)) errors.push(`Preço do tamanho inválido: "${get("preco_tamanho")}".`);
    const servesRaw = get("serve_pessoas");
    const serves = servesRaw === "" ? null : Number(servesRaw);
    const servesOk = serves !== null && Number.isInteger(serves) && serves >= 1 && serves <= 100;
    if (serves !== null && !servesOk) errors.push(`Serve quantas pessoas: "${servesRaw}" não é um número de 1 a 100.`);
    const size = get("tamanho") || null;
    const okPrice = Number.isNaN(price) ? null : price;
    // Com tamanho, o preço dele é o `preco_tamanho` (ou o `preco`, se essa coluna estiver vazia).
    return {
      line,
      category: get("categoria"),
      item: get("item"),
      description: get("descricao") || null,
      priceCents: size ? null : okPrice,
      size,
      sizePriceCents: size ? (Number.isNaN(sizePrice) ? null : (sizePrice ?? okPrice)) : null,
      ingredients: list(get("ingredientes")),
      allergens: list(get("alergenos")),
      servesPeople: servesOk ? serves : null,
      tags: list(get("tags")),
      synonyms: list(get("apelidos")),
      errors,
    };
  });
}

const MAX_PRICE = 100_000_00;

/** Confere os campos de uma linha (vale para o arquivo lido e para as linhas reenviadas no commit). */
export function rowProblems(row: ImportRow): string[] {
  const errors: string[] = [];
  if (!row.category) errors.push("Falta a categoria.");
  else if (row.category.length > 120) errors.push("Categoria com mais de 120 caracteres.");
  if (!row.item) errors.push("Falta o nome do item.");
  else if (row.item.length > 120) errors.push("Nome do item com mais de 120 caracteres.");
  if ((row.description?.length ?? 0) > 2_000) errors.push("Descrição com mais de 2.000 caracteres.");
  if (row.size) {
    if (row.size.length > 120) errors.push("Nome do tamanho com mais de 120 caracteres.");
    if (row.sizePriceCents === null) errors.push("Falta o preço do tamanho.");
    else if (row.sizePriceCents < 0 || row.sizePriceCents > MAX_PRICE) errors.push("Preço do tamanho fora do limite (até R$ 100.000,00).");
  } else if (row.priceCents === null) errors.push("Falta o preço (ou o tamanho com o preço dele).");
  else if (row.priceCents < 0 || row.priceCents > MAX_PRICE) errors.push("Preço fora do limite (até R$ 100.000,00).");
  const lists = [["Ingredientes", row.ingredients], ["Alérgenos", row.allergens], ["Tags", row.tags], ["Apelidos", row.synonyms]] as const;
  for (const [label, values] of lists) {
    if (values.length > 40 || values.some((value) => value.length > 60)) errors.push(`${label}: no máximo 40 itens de até 60 caracteres.`);
  }
  return errors;
}

const key = (value: string) => value.trim().toLowerCase();

/**
 * Soma os erros de cada linha (campos, item repetido, item que já existe, mistura de preço único e tamanhos) e monta o plano.
 * Uma linha com erro derruba o item inteiro, para não criar um item com tamanhos faltando.
 * `existing`: categoria (minúscula) -> itens (minúsculos) que o restaurante já tem.
 */
export function planImport(input: ImportRow[], existing: Map<string, Set<string>>): { rows: ImportRow[]; plan: ImportPlanCategory[]; counts: ImportCounts } {
  // Preço ilegível já tem a sua mensagem: não repete "Falta o preço".
  const rows = input.map((row) => ({
    ...row,
    errors: [...row.errors, ...rowProblems(row).filter((message) => !(message.startsWith("Falta o preço") && row.errors.some((error) => error.startsWith("Preço"))))],
  }));
  const groups = new Map<string, ImportRow[]>();
  for (const row of rows) {
    if (!row.category || !row.item) continue;
    const groupKey = `${key(row.category)}\u0000${key(row.item)}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), row]);
  }
  for (const group of groups.values()) {
    const first = group[0]!;
    if (existing.get(key(first.category))?.has(key(first.item))) {
      for (const row of group) row.errors.push(`"${row.item}" já existe na categoria "${row.category}" do cardápio.`);
      continue;
    }
    const sized = group.some((row) => row.size);
    const seenSizes = new Set<string>();
    group.forEach((row, position) => {
      if (sized && !row.size) row.errors.push("Outras linhas deste item têm tamanho: preencha o tamanho aqui também.");
      if (!sized && position > 0) row.errors.push(`Item repetido (já aparece na linha ${first.line}). Para tamanhos diferentes, preencha a coluna tamanho.`);
      if (row.size) {
        if (seenSizes.has(key(row.size))) row.errors.push(`Tamanho "${row.size}" repetido neste item.`);
        seenSizes.add(key(row.size));
      }
    });
    if (group.some((row) => row.errors.length)) {
      for (const row of group) {
        if (row.errors.length === 0) row.errors.push("Outra linha deste item tem erro: corrija-a para importar o item.");
      }
    }
  }

  const plan: ImportPlanCategory[] = [];
  for (const group of groups.values()) {
    if (group.some((row) => row.errors.length)) continue;
    const first = group[0]!;
    let category = plan.find((entry) => key(entry.name) === key(first.category));
    if (!category) {
      category = { name: first.category, existing: existing.has(key(first.category)), items: [] };
      plan.push(category);
    }
    const sized = group.some((row) => row.size);
    const pick = <T>(read: (row: ImportRow) => T | null) => group.map(read).find((value) => value !== null) ?? null;
    const merged = (field: "ingredients" | "allergens" | "tags" | "synonyms") => [...new Set(group.flatMap((row) => row[field]))];
    category.items.push({
      name: first.item,
      description: pick((row) => row.description),
      priceCents: sized ? null : first.priceCents,
      sizes: sized ? group.map((row) => ({ name: row.size!, priceCents: row.sizePriceCents! })) : [],
      ingredients: merged("ingredients"),
      allergens: merged("allergens"),
      servesPeople: pick((row) => row.servesPeople),
      tags: merged("tags"),
      synonyms: merged("synonyms"),
    });
  }
  const invalidRows = rows.filter((row) => row.errors.length).length;
  const items = plan.flatMap((category) => category.items);
  return {
    rows,
    plan,
    counts: {
      rows: rows.length,
      validRows: rows.length - invalidRows,
      invalidRows,
      categories: plan.filter((category) => !category.existing).length,
      items: items.length,
      sizes: items.reduce((total, item) => total + item.sizes.length, 0),
    },
  };
}
