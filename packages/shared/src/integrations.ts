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
    /** Aplicativo distribuído no iFood: cada loja autoriza o Dish Desk com um código de vinculação. */
    ifoodLinkCode: boolean;
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
    // Centralizado: obrigatório. Distribuído: descoberto automaticamente, mas pode ser fornecido para retrocompatibilidade.
    merchantId: z.string().trim().min(3, "Informe o ID da loja.").max(100, "ID longo demais.").optional(),
    name,
    // Aplicativo distribuído: o código que o Portal do Parceiro mostra depois de "Autorizar" e o `state` do código de vinculação.
    authorizationCode: z.string().trim().min(4, "Código de autorização inválido.").max(100, "Código de autorização inválido.").optional(),
    linkState: z.string().max(2000).optional(),
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
 * Código de vinculação do iFood (aplicativo distribuído): o responsável pela loja abre `verificationUrl` no Portal do
 * Parceiro, confere o código e autoriza. `state` volta com o código de autorização ao conectar.
 */
export type IfoodLinkCodeDto = { userCode: string; verificationUrl: string; expiresIn: number; state: string };

/** Loja do iFood que veio na autorização. `connected`: já está no Dish Desk (aqui ou em outro restaurante). */
export type IfoodStoreDto = { id: string; name: string | null; connected: boolean };

/**
 * Resposta de "adicionar integração". iFood distribuído com mais de uma loja na autorização: em vez de conectar, devolve
 * as lojas para o restaurante escolher; `selection` (o acesso, cifrado) volta junto com a escolha.
 */
export type AddIntegrationResponse = IntegrationDto | { ifoodStores: IfoodStoreDto[]; selection: string };

/** Lojas do iFood escolhidas entre as que vieram na autorização, cada uma com o nome que o restaurante deu. */
export const IfoodStoresRequest = z.object({
  selection: z.string().min(10).max(20_000),
  stores: z
    .array(z.object({ id: z.string().trim().min(3).max(100), name }))
    .min(1, "Escolha pelo menos uma loja.")
    .max(50),
});
export type IfoodStoresRequest = z.infer<typeof IfoodStoresRequest>;

/** Lojas escolhidas: as conectadas e as recusadas, com o motivo. */
export type IfoodStoresResultDto = { connected: IntegrationDto[]; failed: { id: string; message: string }[] };

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
  /**
   * O redirect_uri que o SDK da Meta usou ao abrir a janela (um endereço interno da Meta). A troca do código pelo token
   * só é aceita com o mesmo valor; sem ele, a API manda vazio.
   */
  redirectUri: z
    .string()
    .max(2000)
    .refine((value) => /^https:\/\/([a-z0-9-]+\.)*facebook\.com\//.test(value), "Endereço de retorno inválido.")
    .optional(),
});
export type WhatsAppSignupRequest = z.infer<typeof WhatsAppSignupRequest>;
