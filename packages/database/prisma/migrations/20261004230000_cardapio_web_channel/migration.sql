-- Cardápio Web: pedidos do cardápio digital do restaurante (trazem o telefone do cliente).
-- Fica numa migration própria porque o valor novo do enum só pode ser usado depois do commit.
-- AlterEnum
ALTER TYPE "ChannelType" ADD VALUE 'CARDAPIO_WEB';
