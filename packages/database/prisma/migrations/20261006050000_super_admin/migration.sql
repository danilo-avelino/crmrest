-- Painel da plataforma (Super Admin, E16). Quem é da equipe da plataforma fica em users.is_super_admin, que só o
-- dono das tabelas altera (pnpm user:add --superadmin). A API continua com app_user: as políticas e funções abaixo
-- abrem o acesso da plataforma só quando o usuário da transação é um super admin ativo, conferido no banco.

CREATE FUNCTION app.is_super_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT coalesce((SELECT u.is_super_admin AND u.is_active FROM public.users u WHERE u.id = app.current_user_id()), false)
  $$;

REVOKE ALL ON FUNCTION app.is_super_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_super_admin() TO app_user;

-- tenants: a plataforma vê e cria todos os restaurantes. Nome, slug e status continuam fora do UPDATE de app_user.
CREATE POLICY platform_select ON tenants FOR SELECT USING (app.is_super_admin());
CREATE POLICY platform_insert ON tenants FOR INSERT WITH CHECK (app.is_super_admin());

-- users: a plataforma vê todas as contas (nomes na auditoria, administradores dos restaurantes). O hash continua fechado.
CREATE POLICY platform_select ON users FOR SELECT USING (app.is_super_admin());

-- Auditoria da plataforma: linhas de audit_logs com tenant_id null, invisíveis para os restaurantes. A tabela mantém só a
-- política padrão de tenant; a plataforma grava e lê pelas duas funções abaixo.
CREATE FUNCTION app.log_platform_action(p_action text, p_tenant_id uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT app.is_super_admin() THEN
    RAISE EXCEPTION 'Só a equipe da plataforma registra ações da plataforma.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.audit_logs (id, tenant_id, user_id, action, entity, entity_id)
  VALUES (gen_random_uuid(), NULL, app.current_user_id(), p_action, 'tenant', p_tenant_id::text);
END;
$$;

REVOKE ALL ON FUNCTION app.log_platform_action(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.log_platform_action(text, uuid) TO app_user;

CREATE FUNCTION app.platform_audit(p_limit int)
  RETURNS TABLE (id uuid, action text, user_name text, tenant_id uuid, tenant_name text, created_at timestamptz)
  LANGUAGE plpgsql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT app.is_super_admin() THEN
    RAISE EXCEPTION 'Só a equipe da plataforma vê a auditoria da plataforma.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT a.id, a.action, u.name, t.id, t.name, a.created_at
    FROM public.audit_logs a
    LEFT JOIN public.users u ON u.id = a.user_id
    LEFT JOIN public.tenants t ON t.id::text = a.entity_id
    WHERE a.tenant_id IS NULL AND a.entity = 'tenant'
    ORDER BY a.created_at DESC
    LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION app.platform_audit(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_audit(int) TO app_user;

-- Suspender e reativar um restaurante; fica registrado na auditoria da plataforma.
CREATE FUNCTION app.set_tenant_status(p_tenant_id uuid, p_status "TenantStatus") RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT app.is_super_admin() THEN
    RAISE EXCEPTION 'Só a equipe da plataforma altera o status do restaurante.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.tenants SET status = p_status WHERE id = p_tenant_id AND status <> p_status;
  IF FOUND THEN
    PERFORM app.log_platform_action(CASE p_status WHEN 'SUSPENDED' THEN 'tenant.suspend' ELSE 'tenant.reactivate' END, p_tenant_id);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app.set_tenant_status(uuid, "TenantStatus") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_tenant_status(uuid, "TenantStatus") TO app_user;

-- Acesso de suporte: no restaurante, o super admin age como administrador. As regras de administrador
-- (usuários e configurações) passam a aceitar também a plataforma, sempre dentro do restaurante do contexto.
-- A plataforma também pode se incluir como administradora (ex.: ao criar um restaurante do próprio grupo).
CREATE OR REPLACE FUNCTION app.create_or_restore_member(
  p_user_id uuid,
  p_tenant_id uuid,
  p_name text,
  p_email text,
  p_password_hash text,
  p_role "TenantRole"
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor_id uuid := app.current_user_id();
  v_email text := lower(btrim(p_email));
  v_user_id uuid;
BEGIN
  IF p_tenant_id <> ALL (app.current_tenant_ids()) THEN
    RAISE EXCEPTION 'Sem acesso a este restaurante.' USING ERRCODE = '42501';
  END IF;

  IF NOT app.is_super_admin() AND NOT EXISTS (
    SELECT 1
    FROM public.tenant_members admin
    WHERE admin.tenant_id = p_tenant_id
      AND admin.user_id = v_actor_id
      AND admin.role = 'ADMIN'
      AND admin.is_active
  ) THEN
    RAISE EXCEPTION 'Só o administrador do restaurante altera os usuários.' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_user_id FROM public.users WHERE email = v_email;

  IF v_user_id = v_actor_id AND NOT app.is_super_admin() THEN
    RAISE EXCEPTION 'Peça a outro administrador para alterar o seu acesso.' USING ERRCODE = '42501';
  END IF;

  IF v_user_id IS NULL THEN
    INSERT INTO public.users (id, name, email, password_hash)
    VALUES (p_user_id, btrim(p_name), v_email, p_password_hash)
    RETURNING id INTO v_user_id;
  END IF;

  INSERT INTO public.tenant_members (tenant_id, user_id, role, is_active)
  VALUES (p_tenant_id, v_user_id, p_role, true)
  ON CONFLICT (tenant_id, user_id)
  DO UPDATE SET role = EXCLUDED.role, is_active = true;

  RETURN v_user_id;
END;
$$;

DROP POLICY member_admin_update ON tenant_members;
CREATE POLICY member_admin_update ON tenant_members FOR UPDATE
  USING (
    tenant_id = ANY (app.current_tenant_ids())
    AND (
      app.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM tenant_members admin
        WHERE admin.tenant_id = tenant_members.tenant_id AND admin.user_id = app.current_user_id()
          AND admin.role = 'ADMIN' AND admin.is_active
      )
    )
  )
  WITH CHECK (
    tenant_id = ANY (app.current_tenant_ids())
    AND (
      app.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM tenant_members admin
        WHERE admin.tenant_id = tenant_members.tenant_id AND admin.user_id = app.current_user_id()
          AND admin.role = 'ADMIN' AND admin.is_active
      )
    )
  );

DROP POLICY tenant_settings_update ON tenants;
CREATE POLICY tenant_settings_update ON tenants FOR UPDATE
  USING (
    id = ANY (app.current_tenant_ids())
    AND (
      app.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM tenant_members m
        WHERE m.tenant_id = tenants.id AND m.user_id = app.current_user_id() AND m.role = 'ADMIN' AND m.is_active
      )
    )
  )
  WITH CHECK (
    id = ANY (app.current_tenant_ids())
    AND (
      app.is_super_admin()
      OR EXISTS (
        SELECT 1 FROM tenant_members m
        WHERE m.tenant_id = tenants.id AND m.user_id = app.current_user_id() AND m.role = 'ADMIN' AND m.is_active
      )
    )
  );
