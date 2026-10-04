-- Renovação dos tokens do Instagram (expiram em 60 dias): o job diário percorre os canais de todos os
-- restaurantes. Esta função os lista sem contexto de tenant; cada canal é lido e gravado depois com a RLS.
CREATE FUNCTION app.instagram_channels()
  RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT c.id, c.tenant_id FROM public.channels c
    JOIN public.tenants t ON t.id = c.tenant_id
    WHERE c.type = 'INSTAGRAM' AND c.status = 'CONNECTED' AND t.status = 'ACTIVE'
  $$;

REVOKE ALL ON FUNCTION app.instagram_channels() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.instagram_channels() TO app_user;
