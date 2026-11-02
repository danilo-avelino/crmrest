-- Tickets ao suporte, abertos no painel da extensão quando a IA não resolve. A IA escreve o resumo; a plataforma vê a lista.

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_session_id_key" ON "support_tickets"("session_id");

-- CreateIndex
CREATE INDEX "support_tickets_tenant_id_created_at_idx" ON "support_tickets"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_tickets
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));
