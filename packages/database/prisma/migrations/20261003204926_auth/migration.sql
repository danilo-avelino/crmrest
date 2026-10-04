-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "context" JSONB,
    "user_agent" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- Acesso às tabelas da plataforma (login e escolha de restaurante, E3) ----------

-- Usuário logado da transação, definido por withTenants() com set_config local.
CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION app.current_user_id() TO app_user;

-- Login: acha o usuário pelo e-mail antes de existir contexto. Única forma de a aplicação ler o hash.
CREATE FUNCTION app.find_login_user(p_email text)
  RETURNS TABLE (id uuid, password_hash text, is_active boolean)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT u.id, u.password_hash, u.is_active FROM public.users u WHERE u.email = lower(p_email) $$;

REVOKE ALL ON FUNCTION app.find_login_user(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_login_user(text) TO app_user;

-- users: o próprio usuário e os colegas dos tenants do contexto; a coluna do hash fica inacessível.
CREATE POLICY user_visibility ON users FOR SELECT
  USING (
    id = app.current_user_id()
    OR EXISTS (
      SELECT 1 FROM tenant_members m
      WHERE m.user_id = users.id AND m.tenant_id = ANY (app.current_tenant_ids())
    )
  );

REVOKE SELECT ON users FROM app_user;
GRANT SELECT (id, name, email, is_super_admin, is_active) ON users TO app_user;

-- tenant_members: os vínculos do próprio usuário (para escolher o restaurante) e os dos tenants do contexto.
CREATE POLICY member_visibility ON tenant_members FOR SELECT
  USING (user_id = app.current_user_id() OR tenant_id = ANY (app.current_tenant_ids()));

-- tenants: os do contexto e aqueles de que o usuário é membro.
CREATE POLICY tenant_visibility ON tenants FOR SELECT
  USING (
    id = ANY (app.current_tenant_ids())
    OR EXISTS (
      SELECT 1 FROM tenant_members m
      WHERE m.tenant_id = tenants.id AND m.user_id = app.current_user_id()
    )
  );

-- sessions: cada usuário só enxerga e grava as próprias.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_sessions ON sessions
  USING (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());
