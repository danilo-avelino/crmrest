-- Tráfego do site institucional, medido pelo próprio Dish Desk: uma linha por página vista ou clique em "Teste grátis",
-- sem cookie e sem o IP (visitor_id é um hash do dia + IP + navegador). O site é público: qualquer um grava; só a
-- plataforma lê. Ninguém altera nem apaga pela aplicação.

-- CreateEnum
CREATE TYPE "SiteVisitKind" AS ENUM ('PAGEVIEW', 'CTA');

-- CreateEnum
CREATE TYPE "SiteDevice" AS ENUM ('DESKTOP', 'MOBILE', 'TABLET');

-- CreateTable
CREATE TABLE "site_visits" (
    "id" UUID NOT NULL,
    "kind" "SiteVisitKind" NOT NULL,
    "path" TEXT NOT NULL,
    "source" TEXT,
    "device" "SiteDevice" NOT NULL,
    "visitor_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_visits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "site_visits_created_at_idx" ON "site_visits"("created_at");

ALTER TABLE site_visits ENABLE ROW LEVEL SECURITY;
CREATE POLICY site_insert ON site_visits FOR INSERT WITH CHECK (true);
CREATE POLICY platform_select ON site_visits FOR SELECT USING (app.is_super_admin());
