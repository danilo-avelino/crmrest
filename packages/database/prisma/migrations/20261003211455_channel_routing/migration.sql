-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "status_error" TEXT;

-- Webhooks chegam sem contexto de tenant: esta função acha o canal pelo id externo
-- (phone_number_id, conta do Instagram, merchant do iFood) e devolve só o necessário
-- para o worker abrir o contexto do tenant certo (§3.5).
CREATE FUNCTION app.resolve_channel(p_type "ChannelType", p_external_id text)
  RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT c.id, c.tenant_id FROM public.channels c
    JOIN public.tenants t ON t.id = c.tenant_id
    WHERE c.type = p_type AND c.external_id = p_external_id AND t.status = 'ACTIVE'
  $$;

REVOKE ALL ON FUNCTION app.resolve_channel("ChannelType", text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_channel("ChannelType", text) TO app_user;
