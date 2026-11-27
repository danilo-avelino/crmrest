-- Meio a meio por tamanho (27/11/2026): cada tamanho do item diz se aceita meio a meio (ex.: broto não aceita).
-- Padrão ligado: o que já existe continua como estava (vale a regra da categoria e do item).
ALTER TABLE "menu_item_sizes" ADD COLUMN "allows_half" BOOLEAN NOT NULL DEFAULT true;
