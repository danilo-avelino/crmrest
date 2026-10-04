-- CreateTable
CREATE TABLE "quick_replies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "shortcut" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quick_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quick_replies_tenant_id_shortcut_key" ON "quick_replies"("tenant_id", "shortcut");

-- AddForeignKey
ALTER TABLE "quick_replies" ADD CONSTRAINT "quick_replies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Isolamento entre tenants (mesma política das demais tabelas de negócio).
ALTER TABLE quick_replies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON quick_replies
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));
