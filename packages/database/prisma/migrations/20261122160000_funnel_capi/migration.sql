-- Conversions API da Meta (F7-04): cada evento do funil guarda quando foi enviado à Meta e o último erro (a saúde da
-- integração, F7-08, sai daqui). O worker envia sem tenant, então esta função lista só os restaurantes com o Pixel e o
-- token da CAPI configurados e eventos ainda não enviados dos últimos 7 dias (o limite da Meta).
ALTER TABLE public.funnel_events ADD COLUMN capi_sent_at timestamptz(3), ADD COLUMN capi_error text;

CREATE INDEX funnel_events_capi_pending_idx ON public.funnel_events (tenant_id, created_at) WHERE capi_sent_at IS NULL;

CREATE FUNCTION app.capi_pending_tenants()
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT t.id FROM public.tenants t
    WHERE t.settings -> 'metaCapi' ->> 'tokenEnc' IS NOT NULL
      AND t.settings -> 'menuStore' ->> 'metaPixelId' IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.funnel_events e
        WHERE e.tenant_id = t.id AND e.capi_sent_at IS NULL AND e.created_at > now() - interval '7 days'
      )
  $$;

REVOKE ALL ON FUNCTION app.capi_pending_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.capi_pending_tenants() TO app_user;
