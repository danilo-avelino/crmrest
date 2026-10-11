-- Trava contra o teste grátis repetido: quem cria outra conta e conecta um canal (WhatsApp, Instagram, iFood...) que
-- já esteve em outro restaurante em teste tem o teste encerrado na hora e cai na tela de pagamento.

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "trial_revoked_at" TIMESTAMPTZ(3);

-- Antes de conectar uma conta: confere se ela está em outro restaurante (a RLS esconde os canais dos outros) e decide.
--   'free'       ninguém mais a tem, ou ela foi liberada do restaurante antigo (que fica com o histórico)
--   'taken'      é de um restaurante pagante, criado pela plataforma ou com o teste em andamento: continua dele
--   'trial_used' este restaurante está em teste e a conta já passou por um teste que acabou há menos de
--                p_reuse_days dias (ou ainda corre): o teste daqui é encerrado
-- Só é liberada a conta de um restaurante que se cadastrou pelo site e nunca pagou, com o teste encerrado ou com a
-- conta desconectada. O canal antigo perde o id externo (ganha um sufixo), a credencial e a conexão.
CREATE FUNCTION app.claim_channel(
  p_tenant_id uuid,
  p_type "ChannelType",
  p_external_id text,
  p_reuse_days int,
  p_empty_credentials bytea
) RETURNS text
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

  SELECT c.id, c.status, t.trial_ends_at, t.paid_until INTO v_other
  FROM public.channels c
  JOIN public.tenants t ON t.id = c.tenant_id
  WHERE c.type = p_type AND c.external_id = p_external_id AND c.tenant_id <> p_tenant_id;
  IF NOT FOUND THEN
    RETURN 'free';
  END IF;
  IF v_other.trial_ends_at IS NULL OR v_other.paid_until IS NOT NULL THEN
    RETURN 'taken';
  END IF;

  SELECT t.trial_ends_at IS NOT NULL AND t.paid_until IS NULL INTO v_in_trial FROM public.tenants t WHERE t.id = p_tenant_id;
  IF v_in_trial AND v_other.trial_ends_at > now() - make_interval(days => p_reuse_days) THEN
    UPDATE public.tenants
    SET trial_revoked_at = now(), trial_ends_at = LEAST(trial_ends_at, now())
    WHERE id = p_tenant_id;
    RETURN 'trial_used';
  END IF;

  IF v_other.trial_ends_at > now() AND v_other.status <> 'DISCONNECTED' THEN
    RETURN 'taken';
  END IF;

  UPDATE public.channels
  SET external_id = external_id || '#' || id::text, status = 'DISCONNECTED', credentials = p_empty_credentials
  WHERE id = v_other.id;
  RETURN 'free';
END;
$$;

REVOKE ALL ON FUNCTION app.claim_channel(uuid, "ChannelType", text, int, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_channel(uuid, "ChannelType", text, int, bytea) TO app_user;
