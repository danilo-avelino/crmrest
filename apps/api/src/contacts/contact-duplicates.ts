import type { TenantTx } from "@dishdesk/database";
import type { DuplicateReason } from "@dishdesk/shared";

export type DuplicateCandidate = { a: string; b: string; tenantId: string; reasons: DuplicateReason[] };

/**
 * Pares de cadastros que parecem ser da mesma pessoa: mesmo telefone, CPF, e-mail, nome completo ou endereço de entrega.
 * Ficam de fora os pares com telefones ou CPFs diferentes (são pessoas diferentes, a união seria recusada) e os que o
 * admin já descartou. Roda sob a RLS: só compara cadastros dos restaurantes do contexto, e nunca entre restaurantes.
 */
export function findDuplicatePairs(tx: TenantTx): Promise<DuplicateCandidate[]> {
  return tx.$queryRaw<DuplicateCandidate[]>`
    WITH c AS (
      SELECT id, tenant_id, phone, cpf_hash,
             nullif(lower(btrim(email)), '') AS email,
             nullif(lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')), '') AS name
      FROM contacts WHERE deleted_at IS NULL
    ),
    addr AS (
      SELECT DISTINCT a.contact_id, a.tenant_id, lower(btrim(a.street)) || '|' || coalesce(lower(btrim(a.number)), '') AS key
      FROM contact_addresses a JOIN c ON c.id = a.contact_id
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
    )
    SELECT m.a, m.b, x.tenant_id AS "tenantId", array_agg(DISTINCT m.reason ORDER BY m.reason) AS reasons
    FROM matches m
    JOIN c x ON x.id = m.a
    JOIN c y ON y.id = m.b
    WHERE NOT (x.phone IS NOT NULL AND y.phone IS NOT NULL AND x.phone <> y.phone)
      AND NOT (x.cpf_hash IS NOT NULL AND y.cpf_hash IS NOT NULL AND x.cpf_hash <> y.cpf_hash)
      AND NOT EXISTS (SELECT 1 FROM contact_duplicate_dismissals d WHERE d.contact_a_id = m.a AND d.contact_b_id = m.b)
    GROUP BY m.a, m.b, x.tenant_id
    ORDER BY m.a, m.b
    LIMIT 200`;
}
