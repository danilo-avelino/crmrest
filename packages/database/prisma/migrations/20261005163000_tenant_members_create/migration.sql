-- Criar/reativar usuários do restaurante pelo painel (Configurações -> Usuários).
-- A API continua com a role app_user; esta função estreita roda como dona das tabelas e confere o admin ativo.
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

  IF NOT EXISTS (
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

  IF v_user_id = v_actor_id THEN
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

REVOKE ALL ON FUNCTION app.create_or_restore_member(uuid, uuid, text, text, text, "TenantRole") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_or_restore_member(uuid, uuid, text, text, text, "TenantRole") TO app_user;
