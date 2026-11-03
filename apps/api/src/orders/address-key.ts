import { z } from "zod";

/** Endereço de entrega como cada integração manda (iFood, Cardápio Web); cada campo pode faltar. */
const RawAddress = z.looseObject({
  street: z.string().nullish(),
  streetName: z.string().nullish(),
  number: z.string().nullish(),
  streetNumber: z.string().nullish(),
  complement: z.string().nullish(),
  reference: z.string().nullish(),
  address_block: z.string().nullish(),
  address_lot: z.string().nullish(),
  neighborhood: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
});

/** Abreviações do tipo e dos títulos do logradouro. "R." e "Rua" são o mesmo endereço. */
const STREET_WORDS: Record<string, string> = {
  r: "rua",
  av: "avenida",
  avda: "avenida",
  al: "alameda",
  tv: "travessa",
  trav: "travessa",
  rod: "rodovia",
  est: "estrada",
  pc: "praca",
  pca: "praca",
  lgo: "largo",
  dr: "doutor",
  prof: "professor",
  profa: "professora",
  eng: "engenheiro",
  sen: "senador",
  dep: "deputado",
  gov: "governador",
  pres: "presidente",
  mal: "marechal",
  gal: "general",
  cel: "coronel",
  sta: "santa",
  sto: "santo",
};

/** Sem maiúsculas, acentos e pontuação. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/n[º°]\s*/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeStreet(text: string): string {
  return normalize(text)
    .split(" ")
    .map((word) => STREET_WORDS[word] ?? word)
    .join(" ");
}

const NAME_MARKER = "condominio|cond|edificio|edif|ed|residencial|resid|res";
const UNIT_MARKER = "bloco|bl|torre|tr|apartamento|apto|apt|ap|unidade|casa|lote|lt|quadra|qd";

/** Partes da unidade: cada uma pode aparecer em qualquer campo, com qualquer abreviação. */
const UNIT_PARTS: { slot: string; pattern: RegExp }[] = [
  { slot: "bloco", pattern: /\b(?:bloco|bl|torre|tr) ?([a-z]|\d+[a-z]?)\b/g },
  { slot: "apto", pattern: /\b(?:apartamento|apto|apt|ap|unidade) ?(\d+[a-z]?|[a-z])\b/g },
  { slot: "casa", pattern: /\bcasa ?(\d+[a-z]?|[a-z])\b/g },
  { slot: "lote", pattern: /\b(?:lote|lt) ?(\d+[a-z]?|[a-z])\b/g },
  { slot: "quadra", pattern: /\b(?:quadra|qd) ?(\d+[a-z]?|[a-z])\b/g },
];
/** O nome do condomínio vai até a próxima parte da unidade (ou o fim do trecho). */
const COMPLEX = new RegExp(`\\b(?:${NAME_MARKER}) ([a-z0-9 ]+?)(?= (?:${UNIT_MARKER})\\b ?|$)`);

type Unit = { slots: Map<string, string>; rest: string };

/** Tira do texto o que identifica a unidade; o que sobra é o resto do complemento. */
function readUnit(segments: string[], unit: Unit): string {
  const rest: string[] = [];
  for (const segment of segments) {
    let text = normalize(segment);
    const complex = text.match(COMPLEX);
    if (complex?.[1] && !unit.slots.has("condominio")) {
      unit.slots.set("condominio", complex[1].trim());
      text = text.replace(complex[0], " ");
    }
    for (const { slot, pattern } of UNIT_PARTS) {
      text = text.replace(pattern, (_match, value: string) => {
        if (!unit.slots.has(slot)) unit.slots.set(slot, value.replace(/^0+(?=\d)/, ""));
        return " ";
      });
    }
    const left = text.replace(/\s+/g, " ").trim();
    if (left) rest.push(left);
  }
  return rest.join(" ");
}

/**
 * Chave do endereço para o alerta de fraude: dois pedidos só caem no mesmo endereço com rua, número, cidade, estado,
 * condomínio, bloco e apartamento iguais. Esses dados são procurados em todos os campos, porque cada integração (e cada
 * cliente) os escreve num lugar: "Bl 2 ap 31" no complemento e "apto 31" com o bloco em `address_block` dão a mesma
 * chave. O resto do complemento também entra ("fundos" é outra entrada). O bairro e o CEP não entram: variam de
 * grafia entre os sistemas. A referência ("perto do mercado") só é lida atrás da unidade.
 * null: sem rua, cidade ou número, não há como dizer que o endereço é idêntico.
 */
export function addressKey(raw: unknown): string | null {
  const parsed = RawAddress.safeParse(raw);
  if (!parsed.success) return null;
  const address = parsed.data;
  const [streetName = "", ...streetExtra] = (address.street ?? address.streetName ?? "").split(",");
  const street = normalizeStreet(streetName);
  const number = normalize(address.number ?? address.streetNumber ?? streetExtra.shift() ?? "");
  const city = normalize(address.city ?? "");
  if (!street || !city || !number || number === "s n" || number === "sn") return null;

  const unit: Unit = { slots: new Map(), rest: "" };
  // Campos próprios primeiro: bloco e lote já vêm com o nome certo.
  if (address.address_block?.trim()) readUnit([`bloco ${address.address_block}`], unit);
  if (address.address_lot?.trim()) readUnit([`lote ${address.address_lot}`], unit);
  const rest = readUnit([...streetExtra, ...(address.complement ?? "").split(/[,;/-]/)], unit);
  readUnit((address.reference ?? "").split(/[,;/-]/), unit);

  const parts = [...unit.slots].sort(([a], [b]) => a.localeCompare(b)).map(([slot, value]) => `${slot}=${value}`);
  const words = rest.split(" ").filter(Boolean).sort().join(" ");
  return [street, number, city, normalize(address.state ?? ""), ...parts, ...(words ? [`resto=${words}`] : [])].join("|");
}

/** Endereço para a equipe ler: "Rua das Acácias, 120 · Cond. Jardim Sul, Bloco B, apto 34 · Vila Mariana". */
export function addressText(raw: unknown): string | null {
  const parsed = RawAddress.safeParse(raw);
  if (!parsed.success) return null;
  const address = parsed.data;
  const street = address.street ?? address.streetName;
  if (!street) return null;
  const number = address.number ?? address.streetNumber;
  const block = address.address_block?.trim() && `Bloco ${address.address_block.trim()}`;
  const lot = address.address_lot?.trim() && `Lote ${address.address_lot.trim()}`;
  return [
    [street, number].filter(Boolean).join(", "),
    [block, lot, address.complement?.trim()].filter(Boolean).join(", "),
    address.neighborhood?.trim(),
  ]
    .filter(Boolean)
    .join(" · ");
}
