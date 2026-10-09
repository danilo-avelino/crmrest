import { blindIndex, type Prisma } from "@dishdesk/database";

/** Busca por nome, telefone ou CPF (pelo hash; o CPF nunca é comparado em claro). */
export function contactSearch(search: string, key: Buffer): Prisma.ContactWhereInput {
  const digits = search.replace(/\D/g, "");
  return {
    OR: [
      { name: { contains: search, mode: "insensitive" } },
      ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : []),
      ...(digits.length === 11 ? [{ cpfHash: blindIndex(digits, key) }] : []),
    ],
  };
}
