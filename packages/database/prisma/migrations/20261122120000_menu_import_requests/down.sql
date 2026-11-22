-- Desfaz 20261122120000_menu_import_requests (rodar à mão; o Prisma não usa este arquivo).
DROP TABLE IF EXISTS "menu_import_requests";
DROP TYPE IF EXISTS "MenuImportStatus";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261122120000_menu_import_requests';
