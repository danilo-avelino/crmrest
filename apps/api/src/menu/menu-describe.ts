/**
 * "Melhorar com IA" na descrição do item (F2-15): o que o painel envia, o prompt e a trava de tamanho. Tudo aqui é puro.
 */
import { z } from "zod";

export const DESCRIBE_MODEL = "claude-haiku-5-5";
export const DESCRIBE_DAILY_LIMIT = 200;
/** Mesmo teto do campo Descrição do item. */
export const DESCRIBE_MAX_CHARS = 2_000;

const list = z.array(z.string().trim().min(1).max(60)).max(40).optional();

export const DescribeRequest = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(DESCRIBE_MAX_CHARS).optional(),
  ingredients: list,
  categoryName: z.string().trim().max(120).optional(),
  tags: list,
  servesPeople: z.number().int().min(1).max(100).nullish(),
});
export type DescribeRequest = z.infer<typeof DescribeRequest>;

export const DESCRIBE_SYSTEM = `Você escreve descrições de itens de cardápio de restaurante em português do Brasil.

Regras:
- Responda só com a descrição: 1 ou 2 frases curtas, no máximo 160 caracteres, texto simples, sem aspas, sem emojis, sem preço.
- Tom apetitoso e natural, sem exagero.
- NUNCA invente ingrediente, origem, preparo, tamanho ou qualquer afirmação que não esteja nos dados recebidos.
- Se os dados forem poucos, apenas melhore o que existe (clareza e apetite), sem acrescentar fatos.
- Mantenha os termos do restaurante (nomes de pratos, ingredientes e jeito de falar) como estão nos dados.`;

/** Os campos do formulário que o modelo pode usar, um por linha. */
export function describePrompt(body: DescribeRequest): string {
  const lines = [`Nome: ${body.name}`];
  if (body.categoryName) lines.push(`Categoria: ${body.categoryName}`);
  if (body.ingredients?.length) lines.push(`Ingredientes: ${body.ingredients.join(", ")}`);
  if (body.tags?.length) lines.push(`Etiquetas: ${body.tags.join(", ")}`);
  if (body.servesPeople) lines.push(`Serve: ${body.servesPeople} pessoa${body.servesPeople === 1 ? "" : "s"}`);
  lines.push(body.description ? `Descrição atual: ${body.description}` : "Descrição atual: (vazia)");
  return `${lines.join("\n")}\n\nEscreva a nova descrição.`;
}

/** Texto limpo: sem aspas em volta nem espaços extras; `null` se vazio ou acima do teto do campo. */
export function cleanSuggestion(text: string): string | null {
  const clean = text
    .trim()
    .replace(/^["“”]+|["“”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean && clean.length <= DESCRIBE_MAX_CHARS ? clean : null;
}
