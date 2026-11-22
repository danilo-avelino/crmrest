-- Desfaz 20261121140000_public_menu (rodar à mão; o Prisma não usa este arquivo).
DROP FUNCTION IF EXISTS app.public_menu_tenant(text);
DELETE FROM _prisma_migrations WHERE migration_name = '20261121140000_public_menu';
