-- Cardápio público (docs/cardapio-ia, F0-04): a rota /api/public/* chega sem login nem contexto de tenant. Esta
-- função acha o restaurante pelo slug e devolve só o id, e só de restaurante ativo com o módulo MENU ligado. O resto
-- (assinatura, configurações, cardápio) é lido depois com withTenants nesse id, sob a RLS.
CREATE FUNCTION app.public_menu_tenant(p_slug text)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT t.id FROM public.tenants t
    JOIN public.tenant_modules m ON m.tenant_id = t.id AND m.module = 'MENU'
    WHERE t.slug = p_slug AND t.status = 'ACTIVE'
  $$;

REVOKE ALL ON FUNCTION app.public_menu_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.public_menu_tenant(text) TO app_user;
