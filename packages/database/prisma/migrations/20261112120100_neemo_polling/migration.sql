-- Polling de pedidos da Neemo: cada loja tem o próprio token (token_account), guardado (cifrado) no canal.
-- Esta função lista os canais sem contexto de tenant; cada um é lido depois com a RLS.
CREATE FUNCTION app.neemo_channels()
  RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT c.id, c.tenant_id FROM public.channels c
    JOIN public.tenants t ON t.id = c.tenant_id
    WHERE c.type = 'NEEMO' AND c.status = 'CONNECTED' AND t.status = 'ACTIVE'
  $$;

REVOKE ALL ON FUNCTION app.neemo_channels() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.neemo_channels() TO app_user;
