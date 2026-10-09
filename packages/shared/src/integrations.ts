import type { ChannelStatus } from "@dishdesk/database/enums";
import { z } from "zod";

/** Sistemas que o restaurante conecta pela página Configurações → Integrações (cada um pode ter várias contas/lojas). */
export const INTEGRATION_TYPES = ["WHATSAPP", "INSTAGRAM", "IFOOD", "CARDAPIO_WEB"] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

/** Uma conta ou loja conectada. Credenciais nunca saem da API. */
export type IntegrationDto = {
  id: string;
  type: IntegrationType;
  name: string;
  externalId: string;
  status: ChannelStatus;
};

export type IntegrationsDto = {
  tenantId: string;
  /** Só o administrador do restaurante adiciona integrações. */
  canEdit: boolean;
  /** Credenciais da plataforma: sem elas, as lojas ficam cadastradas, mas os pedidos não chegam. */
  platform: {
    ifood: boolean;
    cardapioWeb: boolean;
    /** Login do Instagram: sem o app do Instagram configurado no servidor, o botão fica desligado. */
    instagramLogin: boolean;
    /** Cadastro incorporado da Meta (WhatsApp): ids públicos que o SDK do Facebook usa no navegador. */
    whatsappSignup: { appId: string; configId: string } | null;
  };
  integrations: IntegrationDto[];
};

const digits = (message: string) => z.string().trim().regex(/^\d{3,30}$/, message);
const secret = (message: string) => z.string().trim().min(10, message).max(1000, message);
const name = z.string().trim().max(60, "Use até 60 caracteres.").optional();

export const AddIntegrationRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("WHATSAPP"),
    phoneNumberId: digits("O ID do número tem só dígitos."),
    wabaId: digits("O ID da conta (WABA) tem só dígitos."),
    accessToken: secret("Token inválido."),
  }),
  z.object({ type: z.literal("INSTAGRAM"), accessToken: secret("Token inválido.") }),
  z.object({
    type: z.literal("IFOOD"),
    merchantId: z.string().trim().min(3, "Informe o ID da loja.").max(100, "ID longo demais."),
    name,
  }),
  z.object({
    type: z.literal("CARDAPIO_WEB"),
    storeId: digits("O código da loja tem só dígitos."),
    apiKey: secret("Chave de API inválida."),
    name,
  }),
]);
export type AddIntegrationRequest = z.infer<typeof AddIntegrationRequest>;

/**
 * Fim do cadastro incorporado do WhatsApp: o código da janela da Meta e o que ela contou da conta escolhida.
 * A Meta nem sempre conta (ex.: "continuar com as configurações anteriores"): sem a conta ou o número, a API descobre.
 */
export const WhatsAppSignupRequest = z.object({
  code: z.string().trim().min(10, "Código inválido.").max(2000, "Código inválido."),
  wabaId: digits("O ID da conta (WABA) tem só dígitos.").optional(),
  phoneNumberId: digits("O ID do número tem só dígitos.").optional(),
  /** true: número que continua no app WhatsApp Business (Coexistência); false: número novo, a registrar na Cloud API. */
  coexistence: z.boolean().optional(),
});
export type WhatsAppSignupRequest = z.infer<typeof WhatsAppSignupRequest>;
