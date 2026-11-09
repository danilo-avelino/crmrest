-- Nome das lojas do iFood pelo último pedido de cada uma (raw.merchant.name), em qualquer restaurante: na escolha das
-- lojas de uma autorização, quando o iFood não lista as lojas (aplicativo sem o módulo Merchant). Recebe só IDs que
-- vieram do acesso que o próprio responsável pela loja autorizou.
CREATE FUNCTION app.ifood_store_names(ids text[])
  RETURNS TABLE (external_id text, name text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT DISTINCT ON (c.external_id) c.external_id, last.name
    FROM public.channels c
    CROSS JOIN LATERAL (
      SELECT o.raw->'merchant'->>'name' AS name, o.placed_at FROM public.orders o
      WHERE o.channel_id = c.id AND coalesce(o.raw->'merchant'->>'name', '') <> ''
      ORDER BY o.placed_at DESC LIMIT 1
    ) last
    WHERE c.type = 'IFOOD' AND c.external_id = ANY(ids)
    ORDER BY c.external_id, last.placed_at DESC
  $$;

REVOKE ALL ON FUNCTION app.ifood_store_names(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ifood_store_names(text[]) TO app_user;
