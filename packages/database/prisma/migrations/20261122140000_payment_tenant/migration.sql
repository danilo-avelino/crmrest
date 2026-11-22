-- Pix do cardápio (F6): o webhook da Pagar.me chega sem login nem tenant. Esta função acha o restaurante do pagamento
-- pelo nosso id (o "code" que mandamos na cobrança) e pela cobrança da Pagar.me, e devolve só o id do restaurante.
CREATE FUNCTION app.payment_tenant(p_payment_id uuid, p_provider_order text)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT p.tenant_id FROM public.payments p WHERE p.id = p_payment_id AND p.txid = p_provider_order
  $$;

REVOKE ALL ON FUNCTION app.payment_tenant(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payment_tenant(uuid, text) TO app_user;
