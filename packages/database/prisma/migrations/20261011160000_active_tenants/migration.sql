-- Tags automáticas dos clientes: o job de hora em hora percorre todos os restaurantes. Esta função os lista
-- sem contexto de tenant; as tags de cada um são calculadas e gravadas depois com a RLS.
CREATE FUNCTION app.active_tenants()
  RETURNS TABLE (id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT t.id FROM public.tenants t WHERE t.status = 'ACTIVE'
  $$;

REVOKE ALL ON FUNCTION app.active_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.active_tenants() TO app_user;
