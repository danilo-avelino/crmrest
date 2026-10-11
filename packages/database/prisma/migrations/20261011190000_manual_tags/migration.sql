-- Tags manuais: a tag que a equipe criava à mão para quem aplica o golpe do cancelamento passa a ter o nome
-- definitivo, que não acusa o cliente.
UPDATE contacts
SET tags = array_replace(tags, 'Golpista', 'Cancelamento recorrente')
WHERE 'Golpista' = ANY(tags);
