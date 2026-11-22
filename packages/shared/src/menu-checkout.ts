import { z } from "zod";

/**
 * Endereço de entrega do checkout do cardápio público (F3-07, R3 e R12): o mesmo zod no navegador e na API. A
 * validação é própria, em português, e devolve todos os erros de uma vez (o form usa `noValidate`). O ponto de
 * referência e o complemento são opcionais; "Sem número" dispensa o número.
 */
export const CheckoutAddressSchema = z.object({
  /** Só dígitos; vazio quando o cliente não sabe o CEP. */
  zipCode: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ""))
    .refine((v) => v === "" || v.length === 8, "O CEP tem 8 números."),
  street: z.string().trim().min(1, "Informe a rua.").max(120, "A rua pode ter até 120 caracteres."),
  number: z.string().trim().max(20, "O número pode ter até 20 caracteres."),
  noNumber: z.boolean(),
  complement: z.string().trim().max(80, "O complemento pode ter até 80 caracteres."),
  district: z.string().trim().min(1, "Informe o bairro.").max(80, "O bairro pode ter até 80 caracteres."),
  city: z.string().trim().min(1, "Informe a cidade.").max(80, "A cidade pode ter até 80 caracteres."),
  state: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === "" || /^[A-Z]{2}$/.test(v), "Use a sigla do estado, como SP."),
  reference: z.string().trim().max(120, "O ponto de referência pode ter até 120 caracteres."),
});

export type CheckoutAddressInput = z.input<typeof CheckoutAddressSchema>;
export type CheckoutAddress = z.output<typeof CheckoutAddressSchema>;
export type CheckoutAddressField = keyof CheckoutAddressInput;

/** Nome de cada campo no resumo de erros do topo do formulário, na ordem da tela. */
export const CHECKOUT_ADDRESS_LABELS: Record<CheckoutAddressField, string> = {
  zipCode: "CEP",
  street: "Rua",
  number: "Número",
  noNumber: "Sem número",
  complement: "Complemento",
  district: "Bairro",
  city: "Cidade",
  state: "Estado",
  reference: "Ponto de referência",
};

export const NUMBER_REQUIRED = 'Informe o número ou marque "Sem número".';

export type CheckoutAddressResult =
  | { ok: true; address: CheckoutAddress }
  | { ok: false; errors: Partial<Record<CheckoutAddressField, string>> };

/** Valida o endereço inteiro e junta todos os erros (um por campo), inclusive o do número junto com os outros. */
export function validateCheckoutAddress(input: CheckoutAddressInput): CheckoutAddressResult {
  const errors: Partial<Record<CheckoutAddressField, string>> = {};
  const parsed = CheckoutAddressSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as CheckoutAddressField;
      errors[field] ??= issue.message;
    }
  }
  // Fora do zod: o refine de objeto não roda quando outro campo já falhou, e o erro do número tem de vir junto.
  if (!input.noNumber && !input.number.trim()) errors.number ??= NUMBER_REQUIRED;
  if (!parsed.success || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, address: input.noNumber ? { ...parsed.data, number: "" } : parsed.data };
}
