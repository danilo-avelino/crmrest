"use client";

import { BILLING_PLANS, type BillingPlanKey, type CheckoutResponse, TRIAL_REUSE_DAYS } from "@dishdesk/shared";
import { LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AuthAside } from "@/components/auth/auth-aside";
import { useAuth } from "@/components/auth/auth-provider";
import { LogoMark } from "@/components/brand/logo-mark";
import { Button } from "@/components/ui/button";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError, apiRequest } from "@/lib/api";
import { currency, currencyWhole } from "@/lib/format";

const SUPPORT_WHATSAPP = "https://wa.me/5586998179385";
// Depois de voltar da Stripe, a confirmação chega pelo webhook: confere de 3 em 3 segundos, por até 2 minutos.
const CONFIRM_INTERVAL_MS = 3_000;
const CONFIRM_ATTEMPTS = 40;

const PLANS: { key: BillingPlanKey; title: string; period: string; description: string; action: string }[] = [
  { key: "monthly", title: "Mensal", period: "por mês", description: "Cartão de crédito, renovado todo mês.", action: "Assinar no cartão" },
  {
    key: "annual",
    title: "Anual",
    period: "por ano",
    description: `Pix, pagamento único. Sai por ${currency(BILLING_PLANS.annual.amountCents / 100 / 12)} ao mês.`,
    action: "Pagar com Pix",
  },
];

const TITLE = {
  trial: "Seu teste grátis acabou",
  payment: "Sua assinatura venceu",
  reused: "Este teste grátis já foi usado",
} as const;

/**
 * Restaurante bloqueado (teste encerrado, assinatura vencida ou canal que já passou por outro teste grátis): escolha
 * do plano e ida para o pagamento na Stripe.
 * O design ainda não tem este board: segue o board "Login · Escolha de restaurante". Desktop no MVP.
 */
export function SubscriptionWall() {
  const { session, loading, selectContext, logout, reload } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<BillingPlanKey | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const entering = useRef(false);

  const tenant = session?.tenants.find((t) => t.id === params.get("restaurante")) ?? session?.tenants.find((t) => t.blockedBy);
  const confirming = params.get("pago") === "1" && Boolean(tenant?.blockedBy) && !gaveUp;

  // Sem sessão ou sem restaurante, volta ao login. Restaurante liberado (o pagamento foi confirmado): entra nele.
  useEffect(() => {
    if (loading) return;
    if (!session || !tenant) router.replace("/login");
    else if (session.context) router.replace("/inbox");
    else if (!tenant.blockedBy && !entering.current) {
      entering.current = true;
      selectContext({ mode: "tenant", tenantId: tenant.id }).catch(() => router.replace("/login"));
    }
  }, [loading, session, tenant, selectContext, router]);

  useEffect(() => {
    if (!confirming) return;
    let attempts = 0;
    const timer = setInterval(() => {
      if (++attempts > CONFIRM_ATTEMPTS) setGaveUp(true);
      else void reload();
    }, CONFIRM_INTERVAL_MS);
    return () => clearInterval(timer);
    // reload muda de identidade a cada sessão nova; o intervalo não pode recomeçar por isso.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirming]);

  const [leave, leaving] = usePendingAction(() => logout());

  const [pay, paying] = usePendingAction(async (plan: BillingPlanKey) => {
    if (!tenant) return;
    setChosen(plan);
    setError(null);
    try {
      const { url } = await apiRequest<CheckoutResponse>("/auth/billing/checkout", { method: "POST", body: { tenantId: tenant.id, plan } });
      window.location.assign(url);
      // Segura o "Carregando…" enquanto o navegador abre a página de pagamento.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível abrir o pagamento. Tente novamente.");
    }
  });

  if (loading || !session || !tenant?.blockedBy) {
    return (
      <main className="flex min-h-screen items-center justify-center gap-2 text-ink-3" aria-busy>
        <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
        Carregando…
      </main>
    );
  }

  return (
    <main className="flex min-h-screen">
      <section className="flex w-[520px] shrink-0 flex-col overflow-y-auto bg-paper px-16 py-14">
        <div className="mb-[72px] flex items-center gap-2.5">
          <LogoMark className="size-[30px]" />
          <span className="font-heading text-[19px] font-bold tracking-[-0.3px]">Dish Desk</span>
        </div>

        <div className="mb-8">
          <h1 className="mb-2 font-heading text-[26px] leading-[1.1] font-bold tracking-[-0.5px]">{TITLE[tenant.blockedBy]}</h1>
          {tenant.blockedBy === "reused" && (
            <p role="alert" className="mb-3 rounded-lg border border-warning-line bg-warning-lt px-3.5 py-2.5 text-xs text-warning-ink">
              A conta que você conectou já passou por um teste grátis nos últimos {TRIAL_REUSE_DAYS} dias, por isso este teste foi
              encerrado.
            </p>
          )}
          <p className="text-ink-3">
            Para continuar atendendo em <span className="font-medium text-ink-2">{tenant.name}</span>, escolha um plano. Suas
            conversas, clientes e configurações continuam guardados.
          </p>
        </div>

        {confirming ? (
          <p className="flex items-center gap-2 text-ink-2" aria-busy>
            <LoaderCircleIcon className="size-4 animate-spin" aria-hidden />
            Confirmando o pagamento…
          </p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {gaveUp && (
              <p role="alert" className="rounded-lg border border-warning-line bg-warning-lt px-3.5 py-2.5 text-xs text-warning-ink">
                Ainda não recebemos a confirmação do pagamento. Ela pode levar alguns minutos: atualize a página em instantes ou
                fale com a gente.
              </p>
            )}
            {PLANS.map((plan) => (
              <div key={plan.key} className="rounded-xl border border-rule bg-surface px-4 py-3.5">
                <div className="flex items-baseline justify-between">
                  <h2 className="font-heading text-title font-semibold">{plan.title}</h2>
                  <span className="text-ink-3">
                    <span className="font-heading text-[19px] font-bold text-ink tabular-nums">
                      {currencyWhole(BILLING_PLANS[plan.key].amountCents / 100)}
                    </span>{" "}
                    {plan.period}
                  </span>
                </div>
                <p className="mt-0.5 text-ink-3">{plan.description}</p>
                {tenant.role === "ADMIN" && (
                  <Button className="mt-3 w-full" loading={paying && chosen === plan.key} disabled={paying} onClick={() => pay(plan.key)}>
                    {plan.action}
                  </Button>
                )}
              </div>
            ))}
            {tenant.role !== "ADMIN" && (
              <p className="text-ink-2">Só o administrador do restaurante pode assinar. Peça a ele para entrar e escolher o plano.</p>
            )}
            {error && (
              <p role="alert" className="text-[11px] text-tomate">
                {error}
              </p>
            )}
          </div>
        )}

        <div className="mt-auto flex flex-col gap-1.5 pt-8 text-[12px] text-ink-3">
          <p>
            Dúvidas?{" "}
            <a href={SUPPORT_WHATSAPP} target="_blank" rel="noreferrer" className="font-medium text-ink-2 underline underline-offset-2">
              Fale com a gente no WhatsApp
            </a>
            .
          </p>
          <p>
            {session.tenants.some((t) => !t.blockedBy) && (
              <>
                <Link href="/login" className="font-medium text-ink-2 underline underline-offset-2">
                  Escolher outro restaurante
                </Link>
                {" · "}
              </>
            )}
            <button type="button" className="font-medium text-ink-2 underline underline-offset-2" aria-busy={leaving || undefined} onClick={leave}>
              {leaving ? "Carregando…" : "Entrar com outra conta"}
            </button>
          </p>
        </div>
      </section>

      <AuthAside
        title="Tudo continua onde você deixou"
        subtitle="Assim que o pagamento é confirmado, o acesso volta na hora."
        items={[
          "Conversas e histórico dos clientes guardados",
          "Canais conectados continuam recebendo mensagens",
          "Pagamento processado pela Stripe",
        ]}
      />
    </main>
  );
}
