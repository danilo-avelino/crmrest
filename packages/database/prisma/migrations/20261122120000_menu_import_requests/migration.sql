-- Pedido de importação do cardápio do iFood (21/11/2026): o restaurante não importa sozinho; abre um pedido com o nome
-- da loja e o CNPJ, e a equipe da plataforma importa pela Catalog API do iFood.

-- CreateEnum
CREATE TYPE "MenuImportStatus" AS ENUM ('OPEN', 'DONE', 'REJECTED');

-- CreateTable
CREATE TABLE "menu_import_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'IFOOD',
    "store_name" TEXT NOT NULL,
    "cnpj" TEXT NOT NULL,
    "status" "MenuImportStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_import_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "menu_import_requests_tenant_id_created_at_idx" ON "menu_import_requests"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "menu_import_requests" ADD CONSTRAINT "menu_import_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_import_requests" ADD CONSTRAINT "menu_import_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE menu_import_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON menu_import_requests
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));
