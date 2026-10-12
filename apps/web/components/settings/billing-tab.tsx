"use client";

import { BILLING_PLANS, type BillingPlanKey, type CheckoutResponse, type TenantBilling } from "@dishdesk/shared";
import { useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { useSettingsTenant } from "@/components/settings/settings-shell";
import { Button } from "@/components/ui/button";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError, apiRequest } from "@/lib/api";
import { currency, currencyWhole, fullDate } from "@/lib/format";

// Depois de voltar da Stripe, a confirmação chega pelo webhook: busca a sessão de 3 em 3 segundos, por meio minuto.
const CONFIRM_INTERVAL_MS = 3_000;
const CONFIRM_ATTEMPTS = 10;

function status(billing: TenantBilling): string {
  const until = fullDate(billing.accessUntil);
  if (billing.trustUntil) return `Pagamento pendente desde ${until}. O acesso está liberado por confiança até ${fullDate(billing.trustUntil)}.`;
  if (billing.plan === "MONTHLY") return `Plano mensal no cartão, renovado todo mês. Acesso garantido até ${until}.`;
  if (billing.plan === "ANNUAL") return `Plano anual, válido até ${until}.`;
  return `Teste grátis até ${until}.`;
}

/**
 * Aba "Pagamento": situação da assinatura, cartão do plano mensal e plano anual, pagos na Stripe.
 * O design ainda não tem este board: segue as outras abas das configurações. Desktop no MVP.
 */
export function BillingTab() {
  const { session, reload } = useAuth();
  const tenant = useSettingsTenant();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<BillingPlanKey | null>(null);
  const paid = params.get("pago") === "1";

  useEffect(() => {
    if (!paid) return;
    let attempts = 0;
    const timer = setInterval(() => {
      if (++attempts > CONFIRM_ATTEMPTS) clearInterval(timer);
      else void reload();
    }, CONFIRM_INTERVAL_MS);
    return () => clearInterval(timer);
    // reload muda de identidade a cada sessão nova; o intervalo não pode recomeçar por isso.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paid]);

  const [pay, paying] = usePendingAction(async (plan: BillingPlanKey) => {
    setChosen(plan);
    setError(null);
    try {
      const { url } = await apiRequest<CheckoutResponse>("/auth/billing/checkout", { method: "POST", body: { tenantId: tenant.id, plan } });
      window.location.assign(url);
      // Segura o "Carregando…" enquanto o navegador abre a página da Stripe.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível abrir o pagamento. Tente novamente.");
    }
  });

  // Acesso de suporte: quem não é da equipe do restaurante não vê nem paga a assinatura dele.
  const member = session?.tenants.find((t) => t.id === tenant.id);
  const billing = member?.billing;
  if (!billing) {
    return (
      <section className="rounded-xl border border-rule px-5 py-4">
        <h2 className="font-heading text-title font-semibold">Pagamento</h2>
        <p className="mt-1 text-ink-2">
          {member ? "Este restaurante não tem cobrança pelo sistema." : "O pagamento só aparece para a equipe do restaurante."}
        </p>
      </section>
    );
  }

  const upToDate = !billing.trustUntil;
  const monthly = billing.plan === "MONTHLY";
  const annualRunning = upToDate && billing.plan === "ANNUAL";

  return (
    <section className="overflow-hidden rounded-xl border border-rule">
      <div className="border-b border-rule px-5 pt-4 pb-3.5">
        <h2 className="font-heading text-title font-semibold">Pagamento</h2>
        <p className="mt-1 text-ink-2">{status(billing)}</p>
        {paid && (
          <p role="status" className="mt-3 rounded-lg border border-warning-line bg-warning-lt px-3.5 py-2.5 text-xs text-warning-ink">
            Recebemos a sua volta da Stripe. A confirmação do pagamento aparece aqui em instantes.
          </p>
        )}
        {params.get("cartao") === "1" && (
          <p role="status" className="mt-3 rounded-lg border border-success-line bg-success-lt px-3.5 py-2.5 text-xs text-success-ink">
            Cartão atualizado. As próximas cobranças vão para ele.
          </p>
        )}
      </div>

      <div className="flex flex-col divide-y divide-rule-soft">
        <Plan
          title="Plano mensal"
          price={`${currencyWhole(BILLING_PLANS.monthly.amountCents / 100)} por mês`}
          description={
            annualRunning
              ? "Fica disponível quando o plano anual vencer."
              : !upToDate
                ? "A mensalidade pendente é cobrada na hora, no cartão que você cadastrar. Depois, a cobrança é automática todo mês."
                : monthly
                  ? "Troque o cartão que recebe a cobrança automática de todo mês."
                  : "Cartão de crédito, com cobrança automática todo mês. A primeira mensalidade é cobrada na hora."
          }
        >
          {!annualRunning && (
            <Button size="sm" loading={paying && chosen === "monthly"} disabled={paying} onClick={() => pay("monthly")}>
              {monthly ? "Cadastrar novo cartão" : "Assinar no cartão"}
            </Button>
          )}
        </Plan>
        <Plan
          title="Plano anual"
          price={`${currencyWhole(BILLING_PLANS.annual.amountCents / 100)} por ano`}
          description={[
            `Pagamento único, no meio que você preferir. Sai por ${currency(BILLING_PLANS.annual.amountCents / 100 / 12)} ao mês.`,
            upToDate && "O ano é somado ao fim do período atual.",
            monthly && "A assinatura mensal é cancelada quando o pagamento é confirmado.",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <Button size="sm" variant="outline" loading={paying && chosen === "annual"} disabled={paying} onClick={() => pay("annual")}>
            Gerar plano anual
          </Button>
        </Plan>
      </div>

      {error && (
        <p role="alert" className="border-t border-rule-soft px-5 py-3 text-[11px] text-tomate">
          {error}
        </p>
      )}
    </section>
  );
}

function Plan({ title, price, description, children }: { title: string; price: string; description: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-5 py-4">
      <div>
        <h3 className="text-[13px] font-medium">
          {title} <span className="font-normal text-ink-3 tabular-nums">· {price}</span>
        </h3>
        <p className="mt-0.5 text-ink-3">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
