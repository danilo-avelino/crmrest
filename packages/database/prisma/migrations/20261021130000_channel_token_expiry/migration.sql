-- Quando vence o token do canal (WhatsApp e Instagram): o painel avisa "vence em N dias" antes de o canal parar.
-- NULL = não vence (token permanente) ou ainda não conferido.

-- AlterTable
ALTER TABLE "channels" ADD COLUMN "token_expires_at" TIMESTAMPTZ(3);

-- Renovação dos tokens do WhatsApp (o cadastro incorporado entrega tokens de 60 dias): como app.instagram_channels(),
-- lista os canais de todos os restaurantes sem contexto de tenant; cada canal é lido e gravado depois com a RLS.
CREATE FUNCTION app.whatsapp_channels()
  RETURNS TABLE (id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT c.id, c.tenant_id FROM public.channels c
    JOIN public.tenants t ON t.id = c.tenant_id
    WHERE c.type = 'WHATSAPP' AND c.status = 'CONNECTED' AND t.status = 'ACTIVE'
  $$;

REVOKE ALL ON FUNCTION app.whatsapp_channels() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.whatsapp_channels() TO app_user;
