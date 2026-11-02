-- Convite para avaliar a loja no app do iFood (E32): um por pedido, com o desfecho e as horas.

-- CreateEnum
CREATE TYPE "ReviewInviteStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "review_invites" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "ReviewInviteStatus" NOT NULL,
    "reason" TEXT,
    "text" TEXT,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "claimed_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "review_invites_order_id_key" ON "review_invites"("order_id");

-- CreateIndex
CREATE INDEX "review_invites_tenant_id_status_due_at_idx" ON "review_invites"("tenant_id", "status", "due_at");

-- AddForeignKey
ALTER TABLE "review_invites" ADD CONSTRAINT "review_invites_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_invites" ADD CONSTRAINT "review_invites_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE review_invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON review_invites
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));
