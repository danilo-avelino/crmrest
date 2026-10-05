-- Usuários do restaurante pelo painel (Configurações → Usuários, E15): o administrador ativo muda o papel e
-- desativa/reativa os vínculos do próprio restaurante. Só essas duas colunas; criar e apagar vínculos (convite,
-- remoção) continua com a plataforma e os scripts, que usam o dono das tabelas.
REVOKE INSERT, UPDATE, DELETE ON tenant_members FROM app_user;
GRANT UPDATE (role, is_active) ON tenant_members TO app_user;

CREATE POLICY member_admin_update ON tenant_members FOR UPDATE
  USING (
    tenant_id = ANY (app.current_tenant_ids())
    AND EXISTS (
      SELECT 1 FROM tenant_members admin
      WHERE admin.tenant_id = tenant_members.tenant_id AND admin.user_id = app.current_user_id()
        AND admin.role = 'ADMIN' AND admin.is_active
    )
  )
  WITH CHECK (
    tenant_id = ANY (app.current_tenant_ids())
    AND EXISTS (
      SELECT 1 FROM tenant_members admin
      WHERE admin.tenant_id = tenant_members.tenant_id AND admin.user_id = app.current_user_id()
        AND admin.role = 'ADMIN' AND admin.is_active
    )
  );
