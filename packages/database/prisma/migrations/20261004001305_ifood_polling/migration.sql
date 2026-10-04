-- Polling de pedidos do iFood (§6): a credencial é da plataforma e busca os eventos de todas as lojas
-- de uma vez. Esta função lista as lojas conectadas (sem contexto de tenant) devolvendo só o necessário.
CREATE FUNCTION app.ifood_merchants()
  RETURNS TABLE (id uuid, tenant_id uuid, external_id text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT c.id, c.tenant_id, c.external_id FROM public.channels c
    JOIN public.tenants t ON t.id = c.tenant_id
    WHERE c.type = 'IFOOD' AND c.status = 'CONNECTED' AND t.status = 'ACTIVE'
  $$;

REVOKE ALL ON FUNCTION app.ifood_merchants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ifood_merchants() TO app_user;
