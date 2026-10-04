-- Isolamento entre tenants com Row-Level Security (PROJETO_CRM_RESTAURANTES.md §3.3).
--
-- A aplicação conecta com uma role membro de app_user: sem superuser, sem BYPASSRLS e sem ser
-- dona das tabelas, então a RLS vale para ela. As migrations rodam com o dono das tabelas.
-- Em desenvolvimento o login comanda_app é criado por infra/docker/postgres/init; em produção
-- a infra cria o login e executa "GRANT app_user TO <login>".

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END $$;

-- Tenants visíveis na transação atual, definidos por withTenants() com set_config local.
-- Sem contexto retorna lista vazia: nenhuma linha fica visível (falha fechada).
CREATE SCHEMA app;

CREATE FUNCTION app.current_tenant_ids() RETURNS uuid[]
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(nullif(current_setting('app.tenant_ids', true), ''), '{}')::uuid[] $$;

GRANT USAGE ON SCHEMA app TO app_user;
GRANT EXECUTE ON FUNCTION app.current_tenant_ids() TO app_user;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, users, tenant_members, channels, contacts, contact_identities, contact_addresses,
  consents, conversations, messages, orders, order_items, audit_logs
  TO app_user;
-- Tabelas criadas por migrations futuras já nascem com acesso; o teste de isolamento exige RLS nelas.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

-- Plataforma: RLS ligada e nenhuma política = app_user não lê nem grava.
-- O acesso (login, escolha de restaurante, super admin) será aberto no E3/E16.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY;

-- Negócio: cada linha só é visível e gravável dentro dos tenants do contexto.
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channels
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contacts
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE contact_identities ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_identities
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE contact_addresses ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_addresses
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON consents
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversations
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON messages
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orders
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_items
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_logs
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));
