-- Integração excluída (Configurações → Integrações): o canal é desconectado e some do painel e dos avisos da Inbox.
-- A linha continua por causa do histórico (conversas, mensagens e pedidos) e da trava do teste grátis repetido.

-- AlterTable
ALTER TABLE "channels" ADD COLUMN "deleted_at" TIMESTAMPTZ(3);
