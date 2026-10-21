-- Super Admin (E16): módulos por restaurante e acesso liberado à mão (pagamento por fora da Stripe ou cortesia).

-- CreateEnum
CREATE TYPE "ModuleKey" AS ENUM ('CAMPAIGNS');

-- CreateTable
CREATE TABLE "tenant_modules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "module" "ModuleKey" NOT NULL,
    "enabled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_modules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_modules_tenant_id_module_key" ON "tenant_modules"("tenant_id", "module");

-- AddForeignKey
ALTER TABLE "tenant_modules" ADD CONSTRAINT "tenant_modules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- O restaurante vê os próprios módulos, mas não os liga: módulo é pago. Só app.set_tenant_module (plataforma) grava.
ALTER TABLE tenant_modules ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_modules
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));
REVOKE INSERT, UPDATE, DELETE ON tenant_modules FROM app_user;

-- Ação da plataforma com detalhes (o módulo, o plano e a data): como app.log_platform_action, com o campo data.
CREATE FUNCTION app.log_platform_action(p_action text, p_tenant_id uuid, p_data jsonb) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT app.is_super_admin() THEN
    RAISE EXCEPTION 'Só a equipe da plataforma registra ações da plataforma.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.audit_logs (id, tenant_id, user_id, action, entity, entity_id, data)
  VALUES (gen_random_uuid(), NULL, app.current_user_id(), p_action, 'tenant', p_tenant_id::text, p_data);
END;
$$;

REVOKE ALL ON FUNCTION app.log_platform_action(text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.log_platform_action(text, uuid, jsonb) TO app_user;

-- Liga ou desliga um módulo; só registra na auditoria quando algo muda.
CREATE FUNCTION app.set_tenant_module(p_tenant_id uuid, p_module "ModuleKey", p_enabled boolean) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT app.is_super_admin() THEN
    RAISE EXCEPTION 'Só a equipe da plataforma liga e desliga módulos.' USING ERRCODE = '42501';
  END IF;

  IF p_enabled THEN
    INSERT INTO public.tenant_modules (id, tenant_id, module) VALUES (gen_random_uuid(), p_tenant_id, p_module)
    ON CONFLICT (tenant_id, module) DO NOTHING;
  ELSE
    DELETE FROM public.tenant_modules WHERE tenant_id = p_tenant_id AND module = p_module;
  END IF;
  IF FOUND THEN
    PERFORM app.log_platform_action(
      CASE WHEN p_enabled THEN 'tenant.module_on' ELSE 'tenant.module_off' END, p_tenant_id, jsonb_build_object('module', p_module)
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app.set_tenant_module(uuid, "ModuleKey", boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_tenant_module(uuid, "ModuleKey", boolean) TO app_user;

-- Acesso liberado até uma data, com o plano, para quem se cadastrou pelo site (com cobrança). Como um pagamento
-- confirmado, devolve o direito à liberação por confiança. Devolve false para restaurante sem cobrança.
CREATE FUNCTION app.set_tenant_access(p_tenant_id uuid, p_plan "BillingPlan", p_paid_until timestamptz) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT app.is_super_admin() THEN
    RAISE EXCEPTION 'Só a equipe da plataforma libera o acesso.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.tenants
  SET paid_until = p_paid_until, billing_plan = p_plan, trust_until = NULL
  WHERE id = p_tenant_id AND trial_ends_at IS NOT NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM app.log_platform_action('tenant.access_grant', p_tenant_id, jsonb_build_object('plan', p_plan, 'paidUntil', p_paid_until));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION app.set_tenant_access(uuid, "BillingPlan", timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_tenant_access(uuid, "BillingPlan", timestamptz) TO app_user;

-- A auditoria passa a devolver os detalhes da ação.
DROP FUNCTION app.platform_audit(int);
CREATE FUNCTION app.platform_audit(p_limit int)
  RETURNS TABLE (id uuid, action text, user_name text, tenant_id uuid, tenant_name text, data jsonb, created_at timestamptz)
  LANGUAGE plpgsql STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT app.is_super_admin() THEN
    RAISE EXCEPTION 'Só a equipe da plataforma vê a auditoria da plataforma.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT a.id, a.action, u.name, t.id, t.name, a.data, a.created_at
    FROM public.audit_logs a
    LEFT JOIN public.users u ON u.id = a.user_id
    LEFT JOIN public.tenants t ON t.id::text = a.entity_id
    WHERE a.tenant_id IS NULL AND a.entity = 'tenant'
    ORDER BY a.created_at DESC
    LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION app.platform_audit(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.platform_audit(int) TO app_user;
