-- Transcrição dos áudios do cardápio (F5-02): o custo entra em ai_usages com o provedor próprio.
ALTER TYPE "AiProvider" ADD VALUE IF NOT EXISTS 'TRANSCRIPTION';
