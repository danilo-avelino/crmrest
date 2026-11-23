-- Código promocional no cadastro pelo site (23/11/2026). Vendedores e parceiros passam o próprio código ao restaurante:
-- quem se cadastra com ele ganha mais dias de teste grátis, e o restaurante fica ligado ao código (e, por ele, ao
-- vendedor). Até existir a área dos vendedores (docs/vendedores.md), a plataforma cria os códigos direto no banco.

-- CreateTable
CREATE TABLE "promo_codes" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "seller_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id"),
    -- Sempre em maiúsculas e sem espaços: o cadastro compara assim.
    CONSTRAINT "promo_codes_code_format" CHECK ("code" = upper(btrim("code")) AND "code" <> '')
);

-- CreateIndex
CREATE UNIQUE INDEX "promo_codes_code_key" ON "promo_codes"("code");

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "promo_code_id" UUID;

-- CreateIndex
CREATE INDEX "tenants_promo_code_id_idx" ON "tenants"("promo_code_id");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_promo_code_id_fkey" FOREIGN KEY ("promo_code_id") REFERENCES "promo_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Só a plataforma lê e mexe pela aplicação; o cadastro confere o código dentro de app.signup_tenant (SECURITY DEFINER).
ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON promo_codes USING (app.is_super_admin()) WITH CHECK (app.is_super_admin());

-- signup_tenant ganha o código e os dias de teste com ele, e passa a dizer por que não criou: 'created', 'email_taken'
-- ou 'invalid_code' (código que não existe ou foi desativado). O resto fica igual a 20261031130000_ai_by_default.
DROP FUNCTION app.signup_tenant(uuid, uuid, text, text, text, text, text, text, text, int);

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
  p_trial_days int,
  p_promo_code text,
  p_promo_trial_days int
) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_email text := lower(btrim(p_email));
  v_slug text := p_slug;
  v_promo_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.users WHERE email = v_email) THEN
    RETURN 'email_taken';
  END IF;

  IF p_promo_code IS NOT NULL THEN
    SELECT id INTO v_promo_id FROM public.promo_codes WHERE code = upper(btrim(p_promo_code)) AND is_active;
    IF v_promo_id IS NULL THEN
      RETURN 'invalid_code';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.tenants WHERE slug = v_slug) THEN
    v_slug := v_slug || '-' || left(replace(p_tenant_id::text, '-', ''), 8);
  END IF;

  INSERT INTO public.tenants (id, name, slug, trial_ends_at, contact_phone, tax_id, promo_code_id)
  VALUES (
    p_tenant_id, btrim(p_tenant_name), v_slug,
    now() + make_interval(days => CASE WHEN v_promo_id IS NULL THEN p_trial_days ELSE p_promo_trial_days END),
    p_phone, p_tax_id, v_promo_id
  );

  INSERT INTO public.tenant_modules (id, tenant_id, module) VALUES (gen_random_uuid(), p_tenant_id, 'AI');

  INSERT INTO public.users (id, name, email, password_hash)
  VALUES (p_user_id, btrim(p_user_name), v_email, p_password_hash);

  INSERT INTO public.tenant_members (tenant_id, user_id, role)
  VALUES (p_tenant_id, p_user_id, 'ADMIN');

  RETURN 'created';
END;
$$;

REVOKE ALL ON FUNCTION app.signup_tenant(uuid, uuid, text, text, text, text, text, text, text, int, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.signup_tenant(uuid, uuid, text, text, text, text, text, text, text, int, text, int) TO app_user;
