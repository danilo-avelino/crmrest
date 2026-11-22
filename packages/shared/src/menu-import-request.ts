import { z } from "zod";
import { isValidCnpj } from "./billing.js";

// Pedido de importação do cardápio do iFood: o restaurante não importa sozinho; pede (nome da loja e CNPJ) e a equipe
// da plataforma importa pela Catalog API do iFood.

export const MENU_IMPORT_STATUSES = ["OPEN", "DONE", "REJECTED"] as const;
export type MenuImportStatus = (typeof MENU_IMPORT_STATUSES)[number];

export const MENU_IMPORT_STATUS_LABEL: Record<MenuImportStatus, string> = {
  OPEN: "Aguardando a equipe",
  DONE: "Cardápio importado",
  REJECTED: "Não foi possível importar",
};

/** Só os dígitos (e letras do CNPJ alfanumérico), em maiúsculas. */
export function cnpjDigits(value: string): string {
  return value.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export const CreateMenuImportRequest = z.object({
  storeName: z.string().trim().min(2, "Informe o nome da loja no iFood.").max(120, "Use até 120 caracteres."),
  cnpj: z
    .string()
    .transform(cnpjDigits)
    .refine(isValidCnpj, "Informe um CNPJ válido."),
});
export type CreateMenuImportRequest = z.infer<typeof CreateMenuImportRequest>;

export type MenuImportRequestDto = {
  id: string;
  source: "IFOOD";
  storeName: string;
  cnpj: string; // só dígitos
  status: MenuImportStatus;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

/** Pedido na lista da plataforma: com o restaurante, quem pediu e as lojas do iFood conectadas nele. */
export type PlatformMenuImportRequestDto = MenuImportRequestDto & {
  tenantId: string;
  tenantName: string;
  userName: string;
  ifoodStores: { channelId: string; name: string; merchantId: string }[];
};

export const ResolveMenuImportRequest = z.object({
  status: z.enum(["DONE", "REJECTED"]),
  note: z.string().trim().max(500).nullable().default(null),
});
export type ResolveMenuImportRequest = z.infer<typeof ResolveMenuImportRequest>;
