-- Conta (WhatsApp, Instagram, loja do iFood...) já conectada em outro restaurante: fica com quem a autorizou por último.
-- Antes ela continuava do outro restaurante quando ele pagava, era da plataforma ou estava com o teste em andamento.
-- A trava contra o teste grátis repetido continua igual.

DROP FUNCTION app.claim_channel(uuid, "ChannelType", text, int, bytea);

-- Antes de conectar uma conta: confere se ela está em outro restaurante (a RLS esconde os canais dos outros) e decide.
--   'free'       ninguém mais a tem, ou ela foi tirada do restaurante antigo (que fica com o histórico): o canal antigo
--                perde o id externo (ganha um sufixo), a credencial e a conexão. `released` traz a credencial que ele
--                tinha, para a API desfazer o que ficou do lado de fora (a instância da Evolution do WhatsApp por QR Code)
--   'trial_used' este restaurante está em teste e a conta já passou por um teste que acabou há menos de
--                p_reuse_days dias (ou ainda corre): o teste daqui é encerrado e a conta fica onde está
CREATE FUNCTION app.claim_channel(
  p_tenant_id uuid,
  p_type "ChannelType",
  p_external_id text,
  p_reuse_days int,
  p_empty_credentials bytea
) RETURNS TABLE (result text, released bytea)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_other record;
  v_in_trial boolean;
BEGIN
  IF p_tenant_id <> ALL (app.current_tenant_ids()) THEN
    RAISE EXCEPTION 'Sem acesso a este restaurante.' USING ERRCODE = '42501';
  END IF;

  SELECT c.id, c.credentials, t.trial_ends_at, t.paid_until INTO v_other
  FROM public.channels c
  JOIN public.tenants t ON t.id = c.tenant_id
  WHERE c.type = p_type AND c.external_id = p_external_id AND c.tenant_id <> p_tenant_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'free'::text, NULL::bytea;
    RETURN;
  END IF;

  -- A conta é de um restaurante cadastrado pelo site que nunca pagou.
  IF v_other.trial_ends_at IS NOT NULL AND v_other.paid_until IS NULL THEN
    SELECT t.trial_ends_at IS NOT NULL AND t.paid_until IS NULL INTO v_in_trial FROM public.tenants t WHERE t.id = p_tenant_id;
    IF v_in_trial AND v_other.trial_ends_at > now() - make_interval(days => p_reuse_days) THEN
      UPDATE public.tenants
      SET trial_revoked_at = now(), trial_ends_at = LEAST(trial_ends_at, now())
      WHERE id = p_tenant_id;
      RETURN QUERY SELECT 'trial_used'::text, NULL::bytea;
      RETURN;
    END IF;
  END IF;

  UPDATE public.channels
  SET external_id = external_id || '#' || id::text, status = 'DISCONNECTED', credentials = p_empty_credentials
  WHERE id = v_other.id;
  RETURN QUERY SELECT 'free'::text, v_other.credentials;
END;
$$;

REVOKE ALL ON FUNCTION app.claim_channel(uuid, "ChannelType", text, int, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_channel(uuid, "ChannelType", text, int, bytea) TO app_user;
