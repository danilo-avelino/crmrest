-- Integração desconectada (Configurações → Integrações): os webhooks do canal deixam de ser aceitos.
CREATE OR REPLACE FUNCTION app.resolve_channel(p_type "ChannelType", p_external_id text)
  RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT c.id, c.tenant_id FROM public.channels c
    JOIN public.tenants t ON t.id = c.tenant_id
    WHERE c.type = p_type AND c.external_id = p_external_id AND t.status = 'ACTIVE' AND c.status <> 'DISCONNECTED'
  $$;
