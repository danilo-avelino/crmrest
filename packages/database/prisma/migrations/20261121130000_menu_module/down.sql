-- Desfaz 20261121130000_menu_module (rodar à mão; o Prisma não usa este arquivo).
-- O Postgres não remove valor de enum: recria o tipo sem MENU.
DELETE FROM tenant_modules WHERE module = 'MENU';
ALTER TYPE "ModuleKey" RENAME TO "ModuleKey_old";
CREATE TYPE "ModuleKey" AS ENUM ('CAMPAIGNS', 'AI');
ALTER TABLE tenant_modules ALTER COLUMN module TYPE "ModuleKey" USING module::text::"ModuleKey";
-- A função usa o tipo na assinatura: recria com o tipo novo (corpo igual ao de 20261021140000_tenant_modules_access).
DROP FUNCTION app.set_tenant_module(uuid, "ModuleKey_old", boolean);
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
DROP TYPE "ModuleKey_old";
DELETE FROM _prisma_migrations WHERE migration_name = '20261121130000_menu_module';
