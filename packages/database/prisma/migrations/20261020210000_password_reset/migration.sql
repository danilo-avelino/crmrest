-- Redefinição de senha pelo link do e-mail (Supabase Auth, E3): antes de existir contexto, troca o hash do usuário
-- ativo e encerra as sessões abertas, para quem tinha a senha antiga não continuar entrando.
CREATE FUNCTION app.reset_password(p_email text, p_password_hash text) RETURNS uuid
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
  END IF;
  RETURN v_user_id;
END
$$;

REVOKE ALL ON FUNCTION app.reset_password(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reset_password(text, text) TO app_user;
