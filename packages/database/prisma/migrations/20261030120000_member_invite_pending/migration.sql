-- Conta que já existia, adicionada a um restaurante: o cadastro não confere o e-mail, então quem criou a conta antes
-- não pode herdar o papel. O acesso fica pendente (inativo) até a pessoa abrir o link do e-mail do convite e definir
-- a senha em /redefinir-senha, o que prova que ela é a dona do e-mail.
ALTER TABLE "tenant_members" ADD COLUMN "invite_pending" BOOLEAN NOT NULL DEFAULT false;

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
  v_pending boolean := false;
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
  ELSE
    -- Conta de outra pessoa: só entra quando ela aceitar pelo e-mail (a plataforma se incluindo entra direto).
    v_pending := v_user_id <> v_actor_id;
  END IF;

  -- Quem já tinha aceitado (ou era da equipe antes) volta direto; quem ainda não aceitou continua pendente.
  INSERT INTO public.tenant_members (tenant_id, user_id, role, is_active, invite_pending)
  VALUES (p_tenant_id, v_user_id, p_role, NOT v_pending, v_pending)
  ON CONFLICT (tenant_id, user_id)
  DO UPDATE SET role = EXCLUDED.role, is_active = NOT tenant_members.invite_pending;

  RETURN v_user_id;
END;
$$;

-- O link do e-mail (recuperação ou convite) prova o e-mail: além de trocar a senha, libera os acessos pendentes.
CREATE OR REPLACE FUNCTION app.reset_password(p_email text, p_password_hash text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_user_id uuid;
BEGIN
  UPDATE public.users SET password_hash = p_password_hash
  WHERE email = lower(p_email) AND is_active
  RETURNING id INTO v_user_id;

  IF v_user_id IS NOT NULL THEN
    UPDATE public.sessions SET revoked_at = now() WHERE user_id = v_user_id AND revoked_at IS NULL;
    UPDATE public.tenant_members SET is_active = true, invite_pending = false WHERE user_id = v_user_id AND invite_pending;
  END IF;
  RETURN v_user_id;
END
$$;

-- A equipe não libera um convite pendente: só o link do e-mail (app.reset_password) tira a pendência e ativa.
CREATE FUNCTION app.guard_member_invite() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.invite_pending AND NEW.invite_pending AND NEW.is_active THEN
    RAISE EXCEPTION 'Esta pessoa ainda não aceitou o convite.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_members_invite_guard BEFORE UPDATE ON tenant_members
  FOR EACH ROW EXECUTE FUNCTION app.guard_member_invite();

-- O administrador cancela o convite pendente: o link do e-mail deixa de liberar o acesso (a pessoa continua inativa).
CREATE FUNCTION app.cancel_member_invite(p_tenant_id uuid, p_user_id uuid) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_tenant_id <> ALL (app.current_tenant_ids()) THEN
    RAISE EXCEPTION 'Sem acesso a este restaurante.' USING ERRCODE = '42501';
  END IF;

  IF NOT app.is_super_admin() AND NOT EXISTS (
    SELECT 1
    FROM public.tenant_members admin
    WHERE admin.tenant_id = p_tenant_id
      AND admin.user_id = app.current_user_id()
      AND admin.role = 'ADMIN'
      AND admin.is_active
  ) THEN
    RAISE EXCEPTION 'Só o administrador do restaurante altera os usuários.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.tenant_members SET invite_pending = false
  WHERE tenant_id = p_tenant_id AND user_id = p_user_id AND invite_pending;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION app.cancel_member_invite(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.cancel_member_invite(uuid, uuid) TO app_user;
