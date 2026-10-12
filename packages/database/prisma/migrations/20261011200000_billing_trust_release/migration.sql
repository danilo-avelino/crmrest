-- Liberação por confiança: com a assinatura vencida, o restaurante libera o próprio acesso por alguns dias, uma vez por
-- atraso (trust_until volta a ficar vazio quando o pagamento chega). billing_plan guarda o último plano pago, para a
-- aba Pagamento das configurações.

-- AlterTable
ALTER TABLE "tenants"
  ADD COLUMN "trust_until" TIMESTAMPTZ(3),
  ADD COLUMN "billing_plan" "BillingPlan";

UPDATE "tenants" t
SET "billing_plan" = (SELECT p."plan" FROM "billing_payments" p WHERE p."tenant_id" = t."id" ORDER BY p."created_at" DESC LIMIT 1);

-- Qualquer usuário ativo do restaurante libera (quem atende não é quem paga). Devolve false quando não há o que
-- liberar: a assinatura não está vencida ou a liberação deste atraso já foi usada.
CREATE FUNCTION app.release_tenant_trust(p_tenant_id uuid, p_days int) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.tenants t
  SET trust_until = now() + make_interval(days => p_days)
  WHERE t.id = p_tenant_id
    AND t.status = 'ACTIVE'
    AND t.paid_until <= now()
    AND t.trust_until IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.tenant_members m
      WHERE m.tenant_id = t.id AND m.user_id = app.current_user_id() AND m.is_active
    );
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION app.release_tenant_trust(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.release_tenant_trust(uuid, int) TO app_user;

-- O pagamento confirmado também guarda o plano e devolve o direito à liberação por confiança.
CREATE OR REPLACE FUNCTION app.record_tenant_payment(
  p_id text,
  p_tenant_id uuid,
  p_customer_id text,
  p_plan "BillingPlan",
  p_amount_cents int,
  p_paid_until timestamptz
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant_id uuid;
BEGIN
  SELECT t.id INTO v_tenant_id
  FROM public.tenants t
  WHERE t.id = p_tenant_id OR (p_tenant_id IS NULL AND t.stripe_customer_id = p_customer_id);
  IF v_tenant_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.billing_payments (id, tenant_id, plan, amount_cents)
  VALUES (p_id, v_tenant_id, p_plan, p_amount_cents)
  ON CONFLICT (id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.tenants
  SET stripe_customer_id = coalesce(p_customer_id, stripe_customer_id),
      billing_plan = p_plan,
      trust_until = NULL,
      paid_until = CASE p_plan
        WHEN 'ANNUAL' THEN GREATEST(now(), paid_until, trial_ends_at) + interval '1 year'
        ELSE GREATEST(paid_until, p_paid_until)
      END
  WHERE id = v_tenant_id;
END;
$$;
