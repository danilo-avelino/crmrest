-- O Dish Desk é vendido com a IA (31/10/2026): todo restaurante novo já nasce com o atendimento com IA (módulo AI). A
-- plataforma ainda pode desligar (app.set_tenant_module). As duas funções ficam iguais, mais o módulo; o painel da
-- plataforma liga o módulo na própria API. Os restaurantes que já existem são ligados à mão, pelo painel.

CREATE OR REPLACE FUNCTION app.signup_tenant(
  p_tenant_id uuid,
  p_user_id uuid,
  p_tenant_name text,
  p_slug text,
  p_user_name text,
  p_email text,
  p_password_hash text,
  p_phone text,
  p_tax_id text,
  p_trial_days int
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_email text := lower(btrim(p_email));
  v_slug text := p_slug;
BEGIN
  IF EXISTS (SELECT 1 FROM public.users WHERE email = v_email) THEN
    RETURN false;
  END IF;

  IF EXISTS (SELECT 1 FROM public.tenants WHERE slug = v_slug) THEN
    v_slug := v_slug || '-' || left(replace(p_tenant_id::text, '-', ''), 8);
  END IF;

  INSERT INTO public.tenants (id, name, slug, trial_ends_at, contact_phone, tax_id)
  VALUES (p_tenant_id, btrim(p_tenant_name), v_slug, now() + make_interval(days => p_trial_days), p_phone, p_tax_id);

  INSERT INTO public.tenant_modules (id, tenant_id, module) VALUES (gen_random_uuid(), p_tenant_id, 'AI');

  INSERT INTO public.users (id, name, email, password_hash)
  VALUES (p_user_id, btrim(p_user_name), v_email, p_password_hash);

  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  VALUES (p_tenant_id, p_user_id, 'ADMIN');

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION app.add_tenant(p_tenant_id uuid, p_tenant_name text, p_slug text, p_tax_id text, p_billed boolean) RETURNS boolean
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

  INSERT INTO public.tenant_modules (id, tenant_id, module) VALUES (gen_random_uuid(), p_tenant_id, 'AI');

  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  VALUES (p_tenant_id, v_user_id, 'ADMIN');

  IF NOT p_billed THEN
    PERFORM app.log_platform_action('tenant.create', p_tenant_id);
  END IF;
  RETURN true;
END;
$$;
