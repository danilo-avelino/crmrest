-- Restaurantes com um canal que atende os pedidos de outro (o WhatsApp de um grupo; Configurações → Integrações).
-- Os avisos de andamento de um pedido vão também para a conversa em que o cliente confirmou o pedido, que fica no
-- restaurante do canal, e não no do pedido. A RLS não deixa o restaurante do pedido ver esses canais: esta função
-- devolve só os ids dos restaurantes, e cada conversa é lida depois com a RLS.
CREATE FUNCTION app.serving_tenants(served uuid)
  RETURNS TABLE (id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT DISTINCT c.tenant_id FROM public.channels c
    JOIN public.tenants t ON t.id = c.tenant_id
    WHERE served = ANY(c.served_tenant_ids) AND c.tenant_id <> served AND t.status = 'ACTIVE'
  $$;

REVOKE ALL ON FUNCTION app.serving_tenants(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.serving_tenants(uuid) TO app_user;
