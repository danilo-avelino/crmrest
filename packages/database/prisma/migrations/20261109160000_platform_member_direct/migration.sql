-- A plataforma (super admin) adiciona a pessoa direto, sem convite: a conta que já existia ganha o acesso na hora, e um
-- convite que estava pendente passa a valer (sem esperar o link do e-mail). Para os administradores dos restaurantes
-- nada muda: a conta que já existia continua pendente até a pessoa abrir o link do e-mail.
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
  v_platform boolean := app.is_super_admin();
  v_email text := lower(btrim(p_email));
  v_user_id uuid;
  v_pending boolean := false;
BEGIN
  IF p_tenant_id <> ALL (app.current_tenant_ids()) THEN
    RAISE EXCEPTION 'Sem acesso a este restaurante.' USING ERRCODE = '42501';
  END IF;

  IF NOT v_platform AND NOT EXISTS (
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

  IF v_user_id = v_actor_id AND NOT v_platform THEN
    RAISE EXCEPTION 'Peça a outro administrador para alterar o seu acesso.' USING ERRCODE = '42501';
  END IF;

  IF v_user_id IS NULL THEN
    INSERT INTO public.users (id, name, email, password_hash)
    VALUES (p_user_id, btrim(p_name), v_email, p_password_hash)
    RETURNING id INTO v_user_id;
  ELSE
    -- Conta de outra pessoa: só entra quando ela aceitar pelo e-mail (a plataforma adiciona direto).
    v_pending := NOT v_platform;
  END IF;

  -- Quem já tinha aceitado (ou era da equipe antes) volta direto; quem ainda não aceitou continua pendente, a não ser
  -- que a plataforma adicione de novo.
  INSERT INTO public.tenant_members (tenant_id, user_id, role, is_active, invite_pending)
  VALUES (p_tenant_id, v_user_id, p_role, NOT v_pending, v_pending)
  ON CONFLICT (tenant_id, user_id)
  DO UPDATE SET
    role = EXCLUDED.role,
    is_active = v_platform OR NOT tenant_members.invite_pending,
    invite_pending = tenant_members.invite_pending AND NOT v_platform;

  RETURN v_user_id;
END;
$$;
