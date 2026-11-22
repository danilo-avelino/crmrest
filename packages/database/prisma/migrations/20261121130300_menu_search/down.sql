-- Desfaz 20261121130300_menu_search (rodar à mão; o Prisma não usa este arquivo). A extensão fica: outras buscas podem usá-la.
DROP INDEX IF EXISTS "menu_items_search_trgm_idx";
DROP INDEX IF EXISTS "menu_items_name_trgm_idx";
DROP FUNCTION IF EXISTS app.menu_item_search_text(text, text[], text[]);
DELETE FROM _prisma_migrations WHERE migration_name = '20261121130300_menu_search';
