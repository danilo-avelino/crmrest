-- Quem já tem conta adiciona outro restaurante na escolha de restaurante e vira administrador dele. Pode quem é
-- administrador ativo de algum restaurante ativo, ou o super admin. O restaurante novo não tem teste grátis:
-- trial_ends_at igual a created_at deixa ele esperando o primeiro pagamento (tenantBlock "unpaid"). Só o super admin
-- cria um restaurante de teste, sem cobrança (sem trial_ends_at, como os criados pela plataforma), e a criação fica na
-- auditoria da plataforma. Devolve false quando o usuário não pode. O slug ganha um sufixo quando já existe.
CREATE FUNCTION app.add_tenant(p_tenant_id uuid, p_tenant_name text, p_slug text, p_tax_id text, p_billed boolean) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user_id uuid := app.current_user_id();
  v_slug text := p_slug;
BEGIN
  IF NOT (
    app.is_super_admin()
    OR (p_billed AND EXISTS (
      SELECT 1
      FROM public.tenant_members m
      JOIN public.tenants t ON t.id = m.tenant_id
      JOIN public.users u ON u.id = m.user_id
      WHERE m.user_id = v_user_id AND m.role = 'ADMIN' AND m.is_active AND t.status = 'ACTIVE' AND u.is_active
    ))
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (SELECT 1 FROM public.tenants WHERE slug = v_slug) THEN
    v_slug := v_slug || '-' || left(replace(p_tenant_id::text, '-', ''), 8);
  END IF;

  INSERT INTO public.tenants (id, name, slug, created_at, trial_ends_at, tax_id)
  VALUES (p_tenant_id, btrim(p_tenant_name), v_slug, now(), CASE WHEN p_billed THEN now() END, p_tax_id);

  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  VALUES (p_tenant_id, v_user_id, 'ADMIN');

  IF NOT p_billed THEN
    PERFORM app.log_platform_action('tenant.create', p_tenant_id);
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION app.add_tenant(uuid, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.add_tenant(uuid, text, text, text, boolean) TO app_user;
