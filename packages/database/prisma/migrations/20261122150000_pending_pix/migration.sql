-- Pix do cardápio (F6-06): a varredura do worker confere os Pix ainda pendentes (caso o aviso da Pagar.me não chegue) e
-- fecha os vencidos. Ela roda sem tenant, então esta função devolve só o id do pagamento e o do restaurante.
CREATE FUNCTION app.pending_pix_payments(p_limit integer)
  RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT p.id, p.tenant_id FROM public.payments p
    WHERE p.status = 'PENDING' AND p.txid IS NOT NULL
    ORDER BY p.created_at
    LIMIT LEAST(GREATEST(p_limit, 1), 500)
  $$;

REVOKE ALL ON FUNCTION app.pending_pix_payments(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pending_pix_payments(integer) TO app_user;
