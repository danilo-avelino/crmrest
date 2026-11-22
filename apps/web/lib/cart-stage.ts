export type CartStage = "building" | "awaiting_confirmation" | "awaiting_pix" | "paid";

export const CART_STAGE_LABEL: Record<CartStage, string> = {
  building: "Montando",
  awaiting_confirmation: "Aguardando confirmação",
  awaiting_pix: "Aguardando Pix",
  paid: "Pago",
};

/** Cor do texto da etapa: âmbar enquanto espera o cliente, verde depois do pagamento. */
export const CART_STAGE_TONE: Record<CartStage, string> = {
  building: "text-ink-2",
  awaiting_confirmation: "text-warning",
  awaiting_pix: "text-warning",
  paid: "text-success",
};

/** Contador do Pix "mm:ss"; `null` sem validade (a cobrança ainda não informa) e "Expirado" depois dela. */
export function pixCountdown(expiresAt: string | null, now: number): string | null {
  if (!expiresAt) return null;
  const left = Math.max(0, Date.parse(expiresAt) - now);
  if (left === 0) return "Expirado";
  const seconds = Math.ceil(left / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
