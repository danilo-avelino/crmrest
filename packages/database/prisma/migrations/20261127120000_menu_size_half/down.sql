-- Desfaz 20261127120000_menu_size_half (rodar à mão). Todos os tamanhos voltam a aceitar meio a meio.
ALTER TABLE "menu_item_sizes" DROP COLUMN IF EXISTS "allows_half";
