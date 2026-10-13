-- Complementos escolhidos em cada item do pedido (iFood: options e customizations), para a equipe ver o que foi pedido.
-- O preço do item (unit_price) passa a ser gravado já com os complementos, como no Cardápio Web.
ALTER TABLE "order_items" ADD COLUMN "options" TEXT[] DEFAULT ARRAY[]::TEXT[];
