-- Configurações do restaurante pelo painel (links do menu de atendimento; base do E15).
-- Só o administrador ativo do restaurante altera, e só a coluna settings: nome, slug e status
-- continuam exclusivos da plataforma (Super Admin, E16).
REVOKE UPDATE ON tenants FROM app_user;
GRANT UPDATE (settings) ON tenants TO app_user;

CREATE POLICY tenant_settings_update ON tenants FOR UPDATE
  USING (
    id = ANY (app.current_tenant_ids())
    AND EXISTS (
      SELECT 1 FROM tenant_members m
      WHERE m.tenant_id = tenants.id AND m.user_id = app.current_user_id() AND m.role = 'ADMIN' AND m.is_active
    )
  )
  WITH CHECK (
    id = ANY (app.current_tenant_ids())
    AND EXISTS (
      SELECT 1 FROM tenant_members m
      WHERE m.tenant_id = tenants.id AND m.user_id = app.current_user_id() AND m.role = 'ADMIN' AND m.is_active
    )
  );
