-- Desfaz 20261121130100_menu (rodar à mão; o Prisma não usa este arquivo).
DROP TABLE IF EXISTS menu_item_pairings, menu_availabilities, menu_item_option_groups, menu_options,
  menu_option_groups, menu_item_sizes, menu_items, menu_categories, menus CASCADE;
DROP TYPE IF EXISTS "HalfPricingRule";
DELETE FROM _prisma_migrations WHERE migration_name = '20261121130100_menu';
