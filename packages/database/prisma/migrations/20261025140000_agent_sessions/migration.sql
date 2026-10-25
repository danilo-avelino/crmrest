-- Fase 4: agente de implantação e suporte na extensão do Chrome (E31).

-- CreateEnum
CREATE TYPE "AgentSessionKind" AS ENUM ('SETUP', 'SUPPORT');

-- CreateEnum
CREATE TYPE "AgentSessionStatus" AS ENUM ('ACTIVE', 'DONE', 'HANDED_OFF');

-- CreateTable
CREATE TABLE "agent_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "AgentSessionKind" NOT NULL,
    "status" "AgentSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "granted_hosts" TEXT[],
    "failures" INTEGER NOT NULL DEFAULT 0,
    "handoff_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_sessions_tenant_id_created_at_idx" ON "agent_sessions"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_sessions_status_updated_at_idx" ON "agent_sessions"("status", "updated_at");

-- CreateIndex
CREATE INDEX "agent_events_session_id_created_at_idx" ON "agent_events"("session_id", "created_at");

-- AddForeignKey
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_sessions
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));

ALTER TABLE agent_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_events
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));
