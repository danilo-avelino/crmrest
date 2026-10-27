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
  /**
   * WhatsApp ou Instagram: outros restaurantes atendidos por esta conta (a busca de pedidos do atendimento procura
   * neles também). Vazio nos marketplaces e quando a conta atende só o próprio restaurante.
   */
  servedTenantIds: string[];
  /** WhatsApp e Instagram: quando o token vence (ISO); null = não vence ou ainda não conferido. */
  tokenExpiresAt: string | null;
};

/** A partir de quantos dias antes do vencimento do token o painel avisa para reconectar. */
export const TOKEN_EXPIRY_WARNING_DAYS = 10;

/** Dias inteiros até o token vencer, só quando já está na hora de avisar (null fora do aviso; 0 = vence hoje ou venceu). */
export function tokenExpiryWarning(tokenExpiresAt: string | null, now = Date.now()): number | null {
  if (!tokenExpiresAt) return null;
  const days = Math.max(0, Math.floor((Date.parse(tokenExpiresAt) - now) / (24 * 60 * 60 * 1000)));
  return days <= TOKEN_EXPIRY_WARNING_DAYS ? days : null;
}

/** "Vence hoje", "Vence amanhã" ou "Vence em N dias", a partir do resultado de tokenExpiryWarning. */
export function tokenExpiryLabel(days: number): string {
  return days === 0 ? "Vence hoje" : days === 1 ? "Vence amanhã" : `Vence em ${days} dias`;
}

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
    /** WhatsApp por QR Code (Evolution API): sem ela configurada no servidor, o botão fica desligado. */
    whatsappQr: boolean;
  };
  integrations: IntegrationDto[];
  /** Outros restaurantes de que quem está vendo é administrador: os que um WhatsApp ou Instagram pode atender. */
  servableTenants: { id: string; name: string }[];
};

/** Canais de atendimento que podem atender mais de um restaurante (um WhatsApp de grupo, o Instagram de uma rede). */
export const SERVING_TYPES = ["WHATSAPP", "INSTAGRAM"] as const satisfies readonly IntegrationType[];

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

/** Novo nome de uma integração (Configurações → Integrações → Gerenciar). */
export const RenameIntegrationRequest = z.object({ name: z.string().trim().min(1, "Informe o nome.").max(60, "Use até 60 caracteres.") });
export type RenameIntegrationRequest = z.infer<typeof RenameIntegrationRequest>;

/** Restaurantes, além do próprio, que um WhatsApp ou Instagram atende. */
export const ServedTenantsRequest = z.object({ tenantIds: z.array(z.uuid()).max(50) });
export type ServedTenantsRequest = z.infer<typeof ServedTenantsRequest>;

/**
 * Código de vinculação do iFood (aplicativo distribuído): o responsável pela loja abre `verificationUrl` no Portal do
 * Parceiro, confere o código e autoriza. `state` volta com o código de autorização ao conectar.
 */
export type IfoodLinkCodeDto = { userCode: string; verificationUrl: string; expiresIn: number; state: string };

/**
 * Loja do iFood que veio na autorização. `connected`: já está conectada a este restaurante. `elsewhere`: está conectada
 * a outro restaurante, e conectar aqui a tira de lá.
 */
export type IfoodStoreDto = { id: string; name: string | null; connected: boolean; elsewhere: boolean };

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

/**
 * Conexão do WhatsApp por QR Code. `session` identifica a tentativa (a instância na Evolution API); `qr` é a imagem
 * (data URL) a escanear, null enquanto a Evolution ainda não gerou ou quando o número já conectou.
 */
export type WhatsAppQrDto =
  | { status: "waiting"; session: string; qr: string | null }
  | { status: "connected"; session: string; integration: IntegrationDto };
