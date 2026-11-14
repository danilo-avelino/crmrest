import type { TenantTx } from "@dishdesk/database";
import type { DuplicateReason } from "@dishdesk/shared";

/** `sameChance`: o que o Jev disse do par com estes motivos; null se ainda não revisou. */
export type DuplicateCandidate = { a: string; b: string; tenantId: string; reasons: DuplicateReason[]; sameChance: number | null };

/** Partículas que não contam como nome: "Maria da Silva" tem dois nomes. */
const NAME_PARTICLES = ["da", "de", "do", "das", "dos", "e"];
/** A partir de quantos nomes um nome completo igual basta para ser par: nomes curtos se repetem demais na base. */
const LONG_NAME_WORDS = 4;

/** Nome completo longo ("Gislanny Mikaelly da Silva Santos"): igual nos dois cadastros, é quase certeza de ser a mesma pessoa. */
export function isLongName(name: string | null): boolean {
  const words = (name ?? "").toLowerCase().trim().split(/\s+/).filter((word) => word && !NAME_PARTICLES.includes(word));
  return words.length >= LONG_NAME_WORDS;
}

// Endereço: o mesmo lugar escrito de jeitos diferentes ("Av. Abdias Neves, 2260, Bloco Buenos Aires 302" e "Avenida
// Abdias Neves, 2260, Solaris Master Bloco Buenos Aires Apt 302") bate. A rua vale sem o tipo (rua, avenida...), sem
// acento e sem pontuação; o complemento vale pelas palavras que sobram sem as genéricas (apto, bloco...), e um precisa
// conter o outro. Vizinhos do mesmo prédio (apto 21 e apto 22) não batem, nem uma casa com um apartamento.
const ACCENTED = "áàâãäéèêëíìîïóòôõöúùûüç";
const PLAIN = "aaaaaeeeeiiiiooooouuuuc";
const STREET_TYPE = /^(rua|r|avenida|av|avn|travessa|tv|trav|alameda|al|rodovia|rod|estrada|est|praca|pc|pca)\s+/;
const COMPLEMENT_FILLERS = ["apto", "apt", "ap", "apartamento", "bloco", "bl", "casa", "cs", "condominio", "cond", "edificio", "ed", "residencial", "res", "torre", "andar", "sala", "numero", "n", "no", ...NAME_PARTICLES];

type AddressLike = { street: string; number: string | null; city: string; complement: string | null };

function plain(text: string): string {
  const lower = text.toLowerCase();
  let out = "";
  for (const char of lower) {
    const index = ACCENTED.indexOf(char);
    out += index >= 0 ? PLAIN[index] : char;
  }
  return out.replace(/[^a-z0-9]+/g, " ").trim();
}

/** O lugar (rua sem o tipo, número e cidade); null sem número. */
function placeOf(address: AddressLike): string | null {
  const number = plain(address.number ?? "").replace(/ /g, "");
  if (!number) return null;
  return [plain(address.street).replace(STREET_TYPE, ""), number, plain(address.city)].join("|");
}

function unitOf(address: AddressLike): string[] {
  return plain(address.complement ?? "").split(" ").filter((word) => word && !COMPLEMENT_FILLERS.includes(word));
}

/** Os dois endereços são o mesmo lugar de entrega (a mesma regra da consulta de pares). */
export function sameDeliveryAddress(a: AddressLike, b: AddressLike): boolean {
  const place = placeOf(a);
  if (!place || place !== placeOf(b)) return false;
  const [x, y] = [unitOf(a), unitOf(b)];
  if ((x.length === 0) !== (y.length === 0)) return false;
  return x.every((word) => y.includes(word)) || y.every((word) => x.includes(word));
}

/** Até onde a chance do Jev diz que são pessoas diferentes: o par sai da fila sem chegar ao admin. */
export const DIFFERENT_PERSON_UP_TO = 0.3;

/**
 * Quais pares entram, pela revisão do Jev (que vale para os motivos de quando foi feita): "queue", a fila do admin, com
 * os pares que o Jev revisou e não descartou; "queue-without-jev", a fila sem o Jev ligado, que mostra também os não
 * revisados; "unreviewed", os que o Jev ainda precisa olhar. Os que o Jev já descartou nunca voltam (nem com ele desligado).
 */
export type DuplicateFilter = "queue" | "queue-without-jev" | "unreviewed";

/**
 * Pares de cadastros que parecem ser da mesma pessoa: mesmo telefone, CPF, e-mail, nome completo ou endereço de entrega
 * (o mesmo lugar, como em sameDeliveryAddress). O nome sozinho só faz par se for longo (isLongName): nomes curtos se
 * repetem. Ficam de fora os pares com telefones ou CPFs diferentes (são pessoas diferentes, a união seria recusada) e os
 * que o admin já descartou. Roda sob a RLS: só compara cadastros dos restaurantes do contexto, e nunca entre restaurantes.
 */
export function findDuplicatePairs(tx: TenantTx, filter: DuplicateFilter): Promise<DuplicateCandidate[]> {
  return tx.$queryRaw<DuplicateCandidate[]>`
    WITH c AS (
      SELECT id, tenant_id, phone, cpf_hash,
             nullif(lower(btrim(email)), '') AS email,
             nullif(lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')), '') AS name
      FROM contacts WHERE deleted_at IS NULL
    ),
    -- Os mesmos passos de sameDeliveryAddress: texto sem acento e sem pontuação.
    a0 AS (
      SELECT a.contact_id, a.tenant_id,
             btrim(regexp_replace(translate(lower(a.street), ${ACCENTED}, ${PLAIN}), '[^a-z0-9]+', ' ', 'g')) AS street,
             regexp_replace(translate(lower(coalesce(a.number, '')), ${ACCENTED}, ${PLAIN}), '[^a-z0-9]+', '', 'g') AS number,
             btrim(regexp_replace(translate(lower(a.city), ${ACCENTED}, ${PLAIN}), '[^a-z0-9]+', ' ', 'g')) AS city,
             btrim(regexp_replace(translate(lower(coalesce(a.complement, '')), ${ACCENTED}, ${PLAIN}), '[^a-z0-9]+', ' ', 'g')) AS complement
      FROM contact_addresses a JOIN c ON c.id = a.contact_id
    ),
    addr AS (
      SELECT DISTINCT contact_id, tenant_id,
             concat_ws('|', regexp_replace(street, ${STREET_TYPE.source}, ''), number, city) AS place,
             ARRAY(SELECT w FROM regexp_split_to_table(complement, ' ') w WHERE w <> '' AND w <> ALL(${COMPLEMENT_FILLERS}::text[]) ORDER BY w) AS unit
      FROM a0 WHERE number <> ''
    ),
    matches AS (
      SELECT x.id AS a, y.id AS b, 'phone' AS reason
      FROM c x JOIN c y ON x.tenant_id = y.tenant_id AND x.phone = y.phone AND x.id < y.id
      UNION ALL
      SELECT x.id, y.id, 'cpf' FROM c x JOIN c y ON x.tenant_id = y.tenant_id AND x.cpf_hash = y.cpf_hash AND x.id < y.id
      UNION ALL
      SELECT x.id, y.id, 'email' FROM c x JOIN c y ON x.tenant_id = y.tenant_id AND x.email = y.email AND x.id < y.id
      UNION ALL
      -- Só nome completo: o primeiro nome sozinho junta gente demais.
      SELECT x.id, y.id, 'name' FROM c x JOIN c y ON x.tenant_id = y.tenant_id AND x.name = y.name AND x.id < y.id
      WHERE x.name LIKE '% %'
      UNION ALL
      SELECT DISTINCT x.contact_id, y.contact_id, 'address'
      FROM addr x JOIN addr y ON x.tenant_id = y.tenant_id AND x.place = y.place AND x.contact_id < y.contact_id
      WHERE (cardinality(x.unit) = 0) = (cardinality(y.unit) = 0) AND (x.unit <@ y.unit OR y.unit <@ x.unit)
    ),
    pairs AS (
      SELECT m.a, m.b, x.tenant_id AS "tenantId", array_agg(DISTINCT m.reason ORDER BY m.reason) AS reasons, x.name
      FROM matches m
      JOIN c x ON x.id = m.a
      JOIN c y ON y.id = m.b
      WHERE NOT (x.phone IS NOT NULL AND y.phone IS NOT NULL AND x.phone <> y.phone)
        AND NOT (x.cpf_hash IS NOT NULL AND y.cpf_hash IS NOT NULL AND x.cpf_hash <> y.cpf_hash)
        AND NOT EXISTS (SELECT 1 FROM contact_duplicate_dismissals d WHERE d.contact_a_id = m.a AND d.contact_b_id = m.b)
      GROUP BY m.a, m.b, x.tenant_id, x.name
    )
    SELECT p.a, p.b, p."tenantId", p.reasons, r.same_chance AS "sameChance"
    FROM pairs p
    LEFT JOIN contact_duplicate_reviews r ON r.contact_a_id = p.a AND r.contact_b_id = p.b AND r.reasons = p.reasons
    WHERE NOT coalesce(r.same_chance <= ${DIFFERENT_PERSON_UP_TO}, false)
      -- Só o nome: par apenas com o nome longo (a mesma conta de isLongName).
      AND (p.reasons <> ARRAY['name'] OR cardinality(ARRAY(
        SELECT w FROM regexp_split_to_table(p.name, ' ') w WHERE w <> ALL(${NAME_PARTICLES}::text[])
      )) >= ${LONG_NAME_WORDS})
      AND CASE ${filter}::text
        WHEN 'queue' THEN r.id IS NOT NULL
        WHEN 'unreviewed' THEN r.id IS NULL
        ELSE true
      END
    ORDER BY p.a, p.b
    LIMIT 200`;
}
