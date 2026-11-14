-- Pares só pelo nome: a orientação ao Jev mudou (nome longo igual é quase certeza), então ele revisa de novo na varredura.
DELETE FROM contact_duplicate_reviews WHERE reasons = ARRAY['name'];
