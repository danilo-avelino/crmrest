/**
 * Recomendação para um grupo (F4-01): determinística, sem LLM. Usa quantas pessoas cada item serve, as tags, os
 * mais vendidos, os destaques do restaurante e o orçamento.
 */

export type RecommendCandidate = {
  itemId: string;
  name: string;
  /** Tamanho usado na conta: o maior (é a ele que o "serve N pessoas" do item se refere). */
  sizeId: string | null;
  sizeName: string | null;
  unitCents: number;
  servesPeople: number | null;
  /** Texto de busca da preferência: nome, tags e ingredientes, sem acento e em minúsculas. */
  keywords: string;
  /** Vendas recentes (mais vendidos) somadas ao peso dos destaques. */
  popularity: number;
};

export type RecommendLine = { candidate: RecommendCandidate; quantity: number };

export type Recommendation = {
  lines: RecommendLine[];
  servedPeople: number;
  totalCents: number;
  /** Cobre todo mundo dentro do orçamento? */
  coversEveryone: boolean;
  /** Alguma preferência foi atendida (null: sem preferência). */
  preferencesMet: boolean | null;
  alternatives: RecommendCandidate[];
};

export const normalizeText = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Item sem "serve N pessoas" conta como 1. */
const servesOf = (c: RecommendCandidate) => c.servesPeople ?? 1;
const MAX_UNITS = 30;

/**
 * Monta a sugestão: filtra pela preferência (sem nenhum item que a atenda, ignora e avisa), ordena por popularidade,
 * depois pelo preço por pessoa e pelo nome, e vai somando um item de cada vez, em rodízio (variedade), até servir
 * todo mundo ou o orçamento acabar. Itens com "serve N pessoas" vêm antes dos sem.
 */
export function recommend(
  candidates: RecommendCandidate[],
  input: { people: number; preferences?: string[]; budgetCents?: number },
): Recommendation {
  const prefs = (input.preferences ?? []).map((p) => normalizeText(p).trim()).filter(Boolean);
  let pool = candidates;
  let preferencesMet: boolean | null = null;
  if (prefs.length) {
    const matching = candidates.filter((c) => prefs.some((p) => c.keywords.includes(p)));
    preferencesMet = matching.length > 0;
    if (matching.length) pool = matching;
  }
  const withServes = pool.filter((c) => c.servesPeople != null);
  const ranked = [...(withServes.length ? withServes : pool)].sort(
    (a, b) =>
      b.popularity - a.popularity ||
      a.unitCents / servesOf(a) - b.unitCents / servesOf(b) ||
      a.name.localeCompare(b.name, "pt-BR"),
  );

  const budget = input.budgetCents ?? Number.POSITIVE_INFINITY;
  const quantities = new Map<string, number>();
  let served = 0;
  let total = 0;
  let units = 0;
  while (served < input.people && units < MAX_UNITS) {
    let added = false;
    for (const candidate of ranked) {
      if (served >= input.people) break;
      if (total + candidate.unitCents > budget) continue;
      quantities.set(candidate.itemId, (quantities.get(candidate.itemId) ?? 0) + 1);
      served += servesOf(candidate);
      total += candidate.unitCents;
      units++;
      added = true;
    }
    if (!added) break;
  }

  const lines = ranked.filter((c) => quantities.has(c.itemId)).map((candidate) => ({ candidate, quantity: quantities.get(candidate.itemId)! }));
  return {
    lines,
    servedPeople: served,
    totalCents: total,
    coversEveryone: served >= input.people,
    preferencesMet,
    alternatives: ranked.filter((c) => !quantities.has(c.itemId)).slice(0, 3),
  };
}
