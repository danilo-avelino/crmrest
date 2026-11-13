import type { TenantTx } from "@dishdesk/database";
import type { DuplicateReason } from "@dishdesk/shared";

/** `sameChance`: o que o Jev disse do par com estes motivos; null se ainda não revisou. */
export type DuplicateCandidate = { a: string; b: string; tenantId: string; reasons: DuplicateReason[]; sameChance: number | null };

/** A chave do endereço na consulta (rua, número, cidade e complemento sem pontuação); null sem número. */
export function duplicateAddressKey(address: { street: string; number: string | null; city: string; complement: string | null }): string | null {
  const number = address.number?.trim().toLowerCase();
  if (!number) return null;
  const complement = (address.complement ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return [address.street.trim().toLowerCase(), number, address.city.trim().toLowerCase(), complement].join("|");
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
 * (rua, número, complemento e cidade: vizinhos do mesmo prédio não são par). Ficam de fora os pares com telefones ou CPFs
 * diferentes (são pessoas diferentes, a união seria recusada) e os que o admin já descartou. Roda sob a RLS: só compara
 * cadastros dos restaurantes do contexto, e nunca entre restaurantes.
 */
export function findDuplicatePairs(tx: TenantTx, filter: DuplicateFilter): Promise<DuplicateCandidate[]> {
  return tx.$queryRaw<DuplicateCandidate[]>`
    WITH c AS (
      SELECT id, tenant_id, phone, cpf_hash,
             nullif(lower(btrim(email)), '') AS email,
             nullif(lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')), '') AS name
      FROM contacts WHERE deleted_at IS NULL
    ),
    -- A mesma chave de duplicateAddressKey.
    addr AS (
      SELECT DISTINCT a.contact_id, a.tenant_id,
             concat_ws('|', lower(btrim(a.street)), lower(btrim(a.number)), lower(btrim(a.city)),
                       regexp_replace(lower(coalesce(a.complement, '')), '[^[:alnum:]]+', '', 'g')) AS key
      FROM contact_addresses a JOIN c ON c.id = a.contact_id
      WHERE nullif(btrim(a.number), '') IS NOT NULL
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
      SELECT x.contact_id, y.contact_id, 'address'
      FROM addr x JOIN addr y ON x.tenant_id = y.tenant_id AND x.key = y.key AND x.contact_id < y.contact_id
    ),
    pairs AS (
      SELECT m.a, m.b, x.tenant_id AS "tenantId", array_agg(DISTINCT m.reason ORDER BY m.reason) AS reasons
      FROM matches m
      JOIN c x ON x.id = m.a
      JOIN c y ON y.id = m.b
      WHERE NOT (x.phone IS NOT NULL AND y.phone IS NOT NULL AND x.phone <> y.phone)
        AND NOT (x.cpf_hash IS NOT NULL AND y.cpf_hash IS NOT NULL AND x.cpf_hash <> y.cpf_hash)
        AND NOT EXISTS (SELECT 1 FROM contact_duplicate_dismissals d WHERE d.contact_a_id = m.a AND d.contact_b_id = m.b)
      GROUP BY m.a, m.b, x.tenant_id
    )
    SELECT p.a, p.b, p."tenantId", p.reasons, r.same_chance AS "sameChance"
    FROM pairs p
    LEFT JOIN contact_duplicate_reviews r ON r.contact_a_id = p.a AND r.contact_b_id = p.b AND r.reasons = p.reasons
    WHERE NOT coalesce(r.same_chance <= ${DIFFERENT_PERSON_UP_TO}, false)
      AND CASE ${filter}::text
        WHEN 'queue' THEN r.id IS NOT NULL
        WHEN 'unreviewed' THEN r.id IS NULL
        ELSE true
      END
    ORDER BY p.a, p.b
    LIMIT 200`;
}
