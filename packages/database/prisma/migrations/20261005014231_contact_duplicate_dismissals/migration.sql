-- CreateTable
CREATE TABLE "contact_duplicate_dismissals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contact_a_id" UUID NOT NULL,
    "contact_b_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_duplicate_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contact_duplicate_dismissals_tenant_id_idx" ON "contact_duplicate_dismissals"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_duplicate_dismissals_contact_a_id_contact_b_id_key" ON "contact_duplicate_dismissals"("contact_a_id", "contact_b_id");

-- AddForeignKey
ALTER TABLE "contact_duplicate_dismissals" ADD CONSTRAINT "contact_duplicate_dismissals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_duplicate_dismissals" ADD CONSTRAINT "contact_duplicate_dismissals_contact_a_id_fkey" FOREIGN KEY ("contact_a_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_duplicate_dismissals" ADD CONSTRAINT "contact_duplicate_dismissals_contact_b_id_fkey" FOREIGN KEY ("contact_b_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE contact_duplicate_dismissals ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_duplicate_dismissals
  USING (tenant_id = ANY (app.current_tenant_ids()))
  WITH CHECK (tenant_id = ANY (app.current_tenant_ids()));
