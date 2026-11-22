-- Busca do cardápio por trigramas (docs/cardapio-ia, F2-07): "calab", "calabreza" e "linguiça" acham a calabresa.
-- pg_trgm é extensão confiável (trusted): o dono das tabelas a cria sem superusuário. No Supabase ela pode já
-- existir no schema extensions, que está no search_path das migrations.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Texto de busca do item: nome, sinônimos e ingredientes, em minúsculas. IMMUTABLE para entrar no índice;
-- a consulta precisa usar a mesma expressão (ex.: word_similarity(termo, app.menu_item_search_text(...))).
CREATE FUNCTION app.menu_item_search_text(p_name text, p_synonyms text[], p_ingredients text[]) RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  SET search_path = pg_catalog
AS $$
  SELECT lower(p_name || ' ' || coalesce(array_to_string(p_synonyms, ' '), '') || ' ' || coalesce(array_to_string(p_ingredients, ' '), ''))
$$;

GRANT EXECUTE ON FUNCTION app.menu_item_search_text(text, text[], text[]) TO app_user;

CREATE INDEX "menu_items_name_trgm_idx" ON "menu_items" USING gin (lower("name") gin_trgm_ops);
CREATE INDEX "menu_items_search_trgm_idx" ON "menu_items"
  USING gin (app.menu_item_search_text("name", "synonyms", "ingredients") gin_trgm_ops);
