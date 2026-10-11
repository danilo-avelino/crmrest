-- Cadastro pelo site com teste grátis e cobrança (Stripe). trial_ends_at só existe em quem se cadastrou pelo site:
-- restaurante criado pela plataforma fica sem teste e sem cobrança. O acesso vale até paid_until (ou, sem pagamento,
-- até trial_ends_at); depois disso a API não emite token para o restaurante até o pagamento chegar.

-- CreateEnum
CREATE TYPE "BillingPlan" AS ENUM ('MONTHLY', 'ANNUAL');

-- AlterTable
ALTER TABLE "tenants"
  ADD COLUMN "trial_ends_at" TIMESTAMPTZ(3),
  ADD COLUMN "paid_until" TIMESTAMPTZ(3),
  ADD COLUMN "contact_phone" TEXT,
  ADD COLUMN "tax_id" TEXT,
  ADD COLUMN "stripe_customer_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "tenants_stripe_customer_id_key" ON "tenants"("stripe_customer_id");

-- CreateTable
CREATE TABLE "billing_payments" (
    "id" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan" "BillingPlan" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_payments_tenant_id_idx" ON "billing_payments"("tenant_id");

-- AddForeignKey
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Pagamentos: RLS ligada e nenhuma política = app_user não lê nem grava. Só a função abaixo grava.
ALTER TABLE billing_payments ENABLE ROW LEVEL SECURITY;

-- Cadastro pelo site: restaurante em teste, o usuário e o vínculo de administrador, tudo de uma vez e antes de existir
-- contexto. Devolve false se o e-mail já tem conta. O slug ganha um sufixo quando já existe.
CREATE FUNCTION app.signup_tenant(
  p_tenant_id uuid,
  p_user_id uuid,
  p_tenant_name text,
  p_slug text,
  p_user_name text,
  p_email text,
  p_password_hash text,
  p_phone text,
  p_tax_id text,
  p_trial_days int
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_email text := lower(btrim(p_email));
  v_slug text := p_slug;
BEGIN
  IF EXISTS (SELECT 1 FROM public.users WHERE email = v_email) THEN
    RETURN false;
  END IF;

  IF EXISTS (SELECT 1 FROM public.tenants WHERE slug = v_slug) THEN
    v_slug := v_slug || '-' || left(replace(p_tenant_id::text, '-', ''), 8);
  END IF;

  INSERT INTO public.tenants (id, name, slug, trial_ends_at, contact_phone, tax_id)
  VALUES (p_tenant_id, btrim(p_tenant_name), v_slug, now() + make_interval(days => p_trial_days), p_phone, p_tax_id);

  INSERT INTO public.users (id, name, email, password_hash)
  VALUES (p_user_id, btrim(p_user_name), v_email, p_password_hash);

  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  VALUES (p_tenant_id, p_user_id, 'ADMIN');

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION app.signup_tenant(uuid, uuid, text, text, text, text, text, text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.signup_tenant(uuid, uuid, text, text, text, text, text, text, text, int) TO app_user;

-- Pagamento confirmado pelo webhook da Stripe (sem contexto de tenant). p_id é o id da fatura ou da sessão de checkout:
-- a Stripe reenvia eventos, e cada pagamento só conta uma vez. O restaurante vem de p_tenant_id (checkout) ou do
-- cliente da Stripe (renovação). Mensal: paga até p_paid_until. Anual: um ano a partir do fim do acesso atual.
CREATE FUNCTION app.record_tenant_payment(
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
      paid_until = CASE p_plan
        WHEN 'ANNUAL' THEN GREATEST(now(), paid_until, trial_ends_at) + interval '1 year'
        ELSE GREATEST(paid_until, p_paid_until)
      END
  WHERE id = v_tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION app.record_tenant_payment(text, uuid, text, "BillingPlan", int, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_tenant_payment(text, uuid, text, "BillingPlan", int, timestamptz) TO app_user;
