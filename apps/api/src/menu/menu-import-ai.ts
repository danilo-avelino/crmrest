/**
 * Importação do cardápio por foto ou PDF com IA (F2-10): o que o modelo devolve, o prompt e a conversão para as mesmas
 * linhas do CSV (F2-09), que seguem pela mesma revisão e pelo mesmo commit. Tudo aqui é puro.
 */
import { z } from "zod";
import type { ImportRow } from "./menu-import.js";

export const AI_IMPORT_MODEL = "claude-sonnet-5-5";
export const AI_IMPORT_MAX_PAGES = 10;
export const AI_IMPORT_DAILY_LIMIT = 10;
const MB = 1024 * 1024;
export const AI_IMPORT_PDF_MAX_BYTES = 10 * MB;
/** Limite de cada imagem na API do Claude. */
export const AI_IMPORT_IMAGE_MAX_BYTES = 5 * MB;
export const AI_IMPORT_MIMES = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;
export type AiImportMime = (typeof AI_IMPORT_MIMES)[number];

/** Campo que a IA leu com dúvida ou pode corrigir. "price" vale para o preço do item ou do tamanho. */
export const AI_FIELDS = ["category", "item", "description", "size", "price"] as const;
export type AiField = (typeof AI_FIELDS)[number];
const TEXT_FIELDS = ["category", "item", "description", "size"] as const;

/** Formato pedido ao modelo (structured outputs). Preço em reais, como está impresso. */
export const AiExtraction = z.object({
  readable: z.boolean(),
  problem: z.string().nullable(),
  items: z.array(
    z.object({
      category: z.string(),
      item: z.string(),
      description: z.string().nullable(),
      price: z.number().nullable(),
      sizes: z.array(z.object({ name: z.string(), price: z.number().nullable() })),
      page: z.number().int().nullable(),
      lowConfidence: z.array(z.enum(AI_FIELDS)),
      note: z.string().nullable(),
      suggestions: z.array(z.object({ field: z.enum(TEXT_FIELDS), value: z.string() })),
    }),
  ),
});
export type AiExtraction = z.infer<typeof AiExtraction>;

/** O que a revisão mostra junto da linha: campos para conferir, o porquê e as correções sugeridas. */
export type AiRowReview = {
  page: number | null;
  lowConfidence: AiField[];
  note: string | null;
  suggestions: { field: (typeof TEXT_FIELDS)[number]; value: string }[];
};
export type AiImportRow = ImportRow & { ai: AiRowReview };

export const AI_IMPORT_SYSTEM = `Você lê cardápios impressos de restaurantes brasileiros (foto ou PDF) e transcreve os itens para um sistema.

Regras:
- Transcreva todos os itens à venda, na ordem do cardápio, com a categoria (seção) de cada um. Sem seção visível, use "Outros".
- Copie nome e descrição como estão impressos. Não invente itens, descrições nem preços.
- Preço em reais como número (R$ 49,90 vira 49.9). Preço ilegível ou ausente: null e "price" em lowConfidence.
- Item com tamanhos ou porções (Broto, Média, Grande, 300 ml, Meia...): um item só, com "sizes" (nome e preço de cada um) e "price" null.
- "page": a página do PDF onde o item está (1 para foto).
- "lowConfidence": os campos que você leu com dúvida (texto borrado, cortado, reflexo). Em "note", diga em uma frase curta o motivo, em português.
- "suggestions": quando um texto impresso tem erro de ortografia ou digitação, mantenha o texto como está no campo e sugira a correção (ex.: item "Portugeusa" -> {"field":"item","value":"Portuguesa"}; descrição "deal para um jantar a doi." -> "Ideal para um jantar a dois."). Só sugira quando tiver certeza.
- Se o arquivo não for um cardápio ou estiver ilegível, devolva readable false, items vazio e o motivo em "problem".`;

export const AI_IMPORT_PROMPT = "Transcreva os itens deste cardápio no formato pedido.";

const cents = (reais: number | null) => (reais === null || !Number.isFinite(reais) ? null : Math.round(reais * 100));
const clean = (value: string | null) => value?.trim() || null;

/** Cada item extraído vira uma linha (ou uma por tamanho), no formato do CSV, com a numeração sequencial. */
export function toImportRows(extraction: AiExtraction): AiImportRow[] {
  const rows: AiImportRow[] = [];
  for (const entry of extraction.items) {
    const ai: AiRowReview = {
      page: entry.page,
      lowConfidence: [...new Set(entry.lowConfidence)],
      note: clean(entry.note),
      suggestions: entry.suggestions.map((s) => ({ field: s.field, value: s.value.trim() })).filter((s) => s.value),
    };
    const base = {
      category: entry.category.trim(),
      item: entry.item.trim(),
      description: clean(entry.description),
      ingredients: [],
      allergens: [],
      servesPeople: null,
      tags: [],
      synonyms: [],
      errors: [],
    };
    const sizes = entry.sizes.filter((size) => size.name.trim());
    if (sizes.length === 0) {
      rows.push({ ...base, line: rows.length + 1, priceCents: cents(entry.price), size: null, sizePriceCents: null, ai });
    } else {
      for (const size of sizes) {
        rows.push({ ...base, line: rows.length + 1, priceCents: null, size: size.name.trim(), sizePriceCents: cents(size.price), ai });
      }
    }
  }
  return rows;
}

/** Páginas de um PDF pelos objetos `/Type /Page`; 0 quando não dá para contar (objetos comprimidos). */
export function pdfPageCount(bytes: Uint8Array): number {
  return Buffer.from(bytes).toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
}

/** Tipo, tamanho e páginas do arquivo antes de gravar; devolve o problema em português ou null. */
export function aiFileProblem(mime: string, bytes: Uint8Array): string | null {
  if (!(AI_IMPORT_MIMES as readonly string[]).includes(mime)) return "Envie uma foto (JPG, PNG ou WEBP) ou um PDF.";
  if (bytes.byteLength === 0) return "O arquivo está vazio.";
  if (mime === "application/pdf") {
    if (bytes.byteLength > AI_IMPORT_PDF_MAX_BYTES) return "O PDF passa de 10 MB.";
    if (pdfPageCount(bytes) > AI_IMPORT_MAX_PAGES) return `O PDF tem mais de ${AI_IMPORT_MAX_PAGES} páginas. Envie só as do cardápio.`;
  } else if (bytes.byteLength > AI_IMPORT_IMAGE_MAX_BYTES) return "A foto passa de 5 MB.";
  return null;
}
