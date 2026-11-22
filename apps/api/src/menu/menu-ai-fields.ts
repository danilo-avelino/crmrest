/**
 * "Preencher com IA" na aba "Para a IA" do item (F2-15): pedido, saída estruturada do modelo, prompt e a limpeza do que
 * o modelo devolve (alérgeno só da lista fixa, "combina com" só com itens do próprio restaurante). Tudo aqui é puro.
 */
import { z } from "zod";

/** Mesma lista fixa dos chips da aba "Para a IA" no painel. */
export const ALLERGENS = ["Glúten", "Leite", "Ovo", "Soja", "Amendoim", "Castanhas", "Frutos do mar"] as const;

const MAX_PAIRS = 6;

export const AiFieldsRequest = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).optional(),
  categoryName: z.string().trim().max(120).optional(),
  sizes: z
    .array(z.object({ name: z.string().trim().min(1).max(60), priceCents: z.number().int().min(0).max(100_000_00).nullish() }))
    .max(20)
    .optional(),
  priceCents: z.number().int().min(0).max(100_000_00).nullish(),
  /** Item já salvo: fica fora da lista do "combina com". */
  itemId: z.uuid().optional(),
});
export type AiFieldsRequest = z.infer<typeof AiFieldsRequest>;

/** Formato pedido ao modelo (structured outputs); os limites ficam na limpeza abaixo. */
export const AiFieldsOutput = z.object({
  ingredients: z.array(z.string()),
  synonyms: z.array(z.string()),
  tags: z.array(z.string()),
  allergens: z.array(z.string()),
  servesPeople: z.number().int().nullable(),
  aiNotes: z.string().nullable(),
  pairsWith: z.array(z.string()),
});
export type AiFieldsOutput = z.infer<typeof AiFieldsOutput>;

export type AiFieldsResult = AiFieldsOutput;

export type MenuChoice = { id: string; name: string; categoryName: string };

export const AI_FIELDS_SYSTEM = `Você ajuda um restaurante brasileiro a preencher a ficha de um item do cardápio. Essa ficha é o que a IA de atendimento usa para responder clientes no WhatsApp.

Regras:
- ingredients: só os ingredientes explícitos ou claramente implícitos no nome e na descrição (ex.: "Calabresa" implica calabresa). NUNCA invente ingrediente. Na dúvida, deixe de fora.
- synonyms: como o cliente escreve no WhatsApp: abreviações, erros comuns de digitação, jeitos de chamar ("pizza de linguiça", "calab"). Sem repetir o nome exato.
- tags: poucas etiquetas curtas e verdadeiras para os dados (ex.: "picante" só se estiver nos dados).
- allergens: só da lista fixa: ${ALLERGENS.join(", ")}. Sugira apenas o que os ingredientes indicam com segurança; é informação de saúde e a pessoa vai conferir.
- servesPeople: só se os tamanhos ou a descrição permitirem concluir; senão null.
- aiNotes: uma observação curta e útil para o atendimento (ex.: sugerir borda recheada), sem inventar fatos; null se não houver o que dizer.
- pairsWith: ids de itens da lista "Outros itens do cardápio" que combinam de verdade com este. Use só ids da lista; se nada combinar, lista vazia.
- Português do Brasil, sem emojis, sem preços.`;

export function aiFieldsPrompt(body: AiFieldsRequest, others: MenuChoice[]): string {
  const lines = [`Nome: ${body.name}`];
  if (body.categoryName) lines.push(`Categoria: ${body.categoryName}`);
  lines.push(body.description ? `Descrição: ${body.description}` : "Descrição: (vazia)");
  if (body.sizes?.length) lines.push(`Tamanhos: ${body.sizes.map((size) => size.name).join(", ")}`);
  else if (body.priceCents != null) lines.push("Tamanho único");
  lines.push("", "Outros itens do cardápio (id | nome | categoria):");
  lines.push(...(others.length ? others.map((item) => `${item.id} | ${item.name} | ${item.categoryName}`) : ["(nenhum)"]));
  return lines.join("\n");
}

function tidy(values: string[], max = 40): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = value.trim().replace(/\s+/g, " ");
    if (!text || text.length > 60 || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length === max) break;
  }
  return out;
}

/** Descarta o que não vale: alérgeno fora da lista, item de outro restaurante, número fora de 1 a 100. */
export function sanitizeAiFields(output: AiFieldsOutput, validIds: ReadonlySet<string>): AiFieldsResult {
  const allergens = ALLERGENS.filter((name) => output.allergens.some((value) => value.trim().toLowerCase() === name.toLowerCase()));
  const notes = output.aiNotes?.trim() ?? "";
  const serves = output.servesPeople;
  return {
    ingredients: tidy(output.ingredients),
    synonyms: tidy(output.synonyms),
    tags: tidy(output.tags),
    allergens: [...allergens],
    servesPeople: serves !== null && Number.isInteger(serves) && serves >= 1 && serves <= 100 ? serves : null,
    aiNotes: notes && notes.length <= 2_000 ? notes : null,
    pairsWith: [...new Set(output.pairsWith.map((id) => id.trim()).filter((id) => validIds.has(id)))].slice(0, MAX_PAIRS),
  };
}
