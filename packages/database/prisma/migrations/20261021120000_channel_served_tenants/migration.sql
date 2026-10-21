-- WhatsApp ou Instagram que atende várias unidades (Configurações → Integrações): outros restaurantes do mesmo
-- administrador cujos pedidos o atendimento deste canal também procura. As conversas continuam no restaurante do canal.

-- AlterTable
ALTER TABLE "channels" ADD COLUMN "served_tenant_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
