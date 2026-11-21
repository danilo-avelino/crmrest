import { BILLING_PLANS, type BillingPlanKey, type CheckoutResponse } from "@dishdesk/shared";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError, apiRequest } from "@/lib/api";
import { currencyWhole } from "@/lib/format";

export const ANNUAL_PLAN_TEXT = `No cartão em até 10x de ${currencyWhole(BILLING_PLANS.annual.amountCents / 100 / 10)} sem juros, ou no Pix.`;

const CONFIRM_INTERVAL_MS = 3_000;

/**
 * Depois de voltar da Stripe ou da InfinitePay, a confirmação chega pelo webhook: com `active`, busca a sessão de 3 em
 * 3 segundos, até `attempts` vezes. Devolve true quando as tentativas acabam.
 */
export function useConfirmPaymentReturn(active: boolean, attempts: number): boolean {
  const { reload } = useAuth();
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (!active) return;
    let count = 0;
    const timer = setInterval(() => {
      if (++count > attempts) {
        clearInterval(timer);
        setGaveUp(true);
      } else void reload();
    }, CONFIRM_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active, attempts, reload]);
  return gaveUp;
}

/** Abre o pagamento do plano (mensal na Stripe, anual na InfinitePay) do restaurante. */
export function useCheckout(tenantId: string | undefined) {
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<BillingPlanKey | null>(null);
  const [pay, paying] = usePendingAction(async (plan: BillingPlanKey) => {
    if (!tenantId) return;
    setChosen(plan);
    setError(null);
    try {
      const { url } = await apiRequest<CheckoutResponse>("/auth/billing/checkout", { method: "POST", body: { tenantId, plan } });
      window.location.assign(url);
      // Segura o "Carregando…" enquanto o navegador abre a página de pagamento.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível abrir o pagamento. Tente novamente.");
    }
  });
  return { pay, paying, chosen, error, setError };
}
