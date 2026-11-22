-- Recuperação de carrinho parado (F7-07): quando a equipe mandou a mensagem, para não mandar duas vezes.
ALTER TABLE "carts" ADD COLUMN "recovery_sent_at" TIMESTAMPTZ(3);
