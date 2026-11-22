import type { InteractiveOption } from "../connectors/connector.js";

/** As opções oferecidas guardadas na conversa (automationState.offered) valem só por este tempo: depois, "2" é só um "2". */
export const OFFER_TTL_MS = 30 * 60 * 1000;

/** Um agente oferece de 2 a 10 opções (o máximo de uma lista do WhatsApp). */
export const OFFER_MIN = 2;
export const OFFER_MAX = 10;
export const OPTION_TITLE_MAX = 60;

export type Offered = { options: InteractiveOption[]; at: string };

/** Minúsculas, sem acento nem pontuação, espaços únicos ("A Segunda!" vira "a segunda"). */
export function normalizeChoice(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NUMBER_WORDS: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  primeiro: 1, primeira: 1, segundo: 2, segunda: 2, terceiro: 3, terceira: 3, quarto: 4, quarta: 4, quinto: 5, quinta: 5,
  sexto: 6, sexta: 6, setimo: 7, setima: 7, oitavo: 8, oitava: 8, nono: 9, nona: 9, decimo: 10, decima: 10,
};
const FILLERS = new Set(["a", "o", "as", "os", "na", "no", "pela", "pelo", "quero", "pode", "ser", "vai", "de", "da", "do", "numero", "n", "opcao", "item", "alternativa", "ficar", "com", "e", "esse", "essa", "mesmo", "mesma", "escolho", "fico"]);

/** O número da opção em "2", "dois", "a segunda", "opção 2", "2º"; null se o texto não é só isso. */
function positionOf(words: string[]): number | null {
  if (words.length !== 1) return null;
  const word = words[0]!;
  const digits = /^(\d{1,2})[oa]?$/.exec(word);
  return digits ? Number(digits[1]) : (NUMBER_WORDS[word] ?? null);
}

/**
 * Qual das opções oferecidas o cliente escolheu: o id de um botão ou item de lista (`replyId`), o número ("2", "dois",
 * "a segunda"), o título inteiro ou um pedaço dele que só uma opção tem (sem acento nem caixa). Null se não for uma
 * escolha clara: a mensagem segue como o cliente escreveu e o modelo decide.
 */
export function resolveChoice(options: InteractiveOption[], text: string | undefined, replyId?: string): InteractiveOption | null {
  if (replyId) return options.find((option) => option.id === replyId) ?? null;
  if (!text) return null;
  const normalized = normalizeChoice(text);
  if (!normalized) return null;
  const words = normalized.split(" ");
  const core = words.filter((word) => !FILLERS.has(word) || positionOf([word]) !== null);
  const position = positionOf(core);
  if (position !== null) return options[position - 1] ?? null;
  const titles = options.map((option) => ({ option, title: normalizeChoice(option.title) }));
  const exact = titles.filter((item) => item.title === normalized || item.title === core.join(" "));
  if (exact.length === 1) return exact[0]!.option;
  const part = core.join(" ");
  if (part.length < 3) return null;
  const partial = titles.filter((item) => item.title.includes(part));
  return partial.length === 1 ? partial[0]!.option : null;
}

/** A pergunta com as opções numeradas, o texto que sai em qualquer conector (e que a Inbox mostra). */
export function numberedText(question: string, options: InteractiveOption[], hint: string): string {
  return `${question}\n\n${options.map((option, index) => `${index + 1}. ${option.title}`).join("\n")}\n\n${hint}`;
}
