-- Desfaz 20261122170000_ai_provider_transcription (rodar à mão). O Postgres não remove valor de enum: apagar as
-- linhas com o provedor e recriar o tipo só se for mesmo preciso. Aqui só some o registro da migration.
DELETE FROM ai_usages WHERE provider = 'TRANSCRIPTION';
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261122170000_ai_provider_transcription';
