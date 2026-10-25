"use client";

import { ONBOARDING_STEPS, type OnboardingDto } from "@dishdesk/shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { SparklesIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { doneCount, resumeIndex, STEP_INFO } from "@/components/onboarding/steps";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const TOTAL = ONBOARDING_STEPS.length;

/**
 * Aviso "Termine a configuração" no início da Inbox, só para o administrador e enquanto a configuração não terminar
 * (no painel master, o primeiro restaurante que falta). No primeiro acesso, o assistente abre sozinho.
 */
export function SetupReminder() {
  const { request, session } = useAuth();
  const router = useRouter();
  const admins = (session?.context?.tenants ?? []).filter((tenant) => tenant.role === "ADMIN");
  const results = useQueries({
    queries: admins.map((tenant) => ({
      queryKey: ["onboarding", tenant.id],
      queryFn: () => request<OnboardingDto>(`/onboarding/${tenant.id}`),
    })),
  });
  const pending = results.map((result) => result.data).find((data) => data && !data.completed);
  const autoOpen = !session?.context?.support && pending?.autoOpen;

  useEffect(() => {
    if (autoOpen && pending) router.push(`/assistente?restaurante=${pending.tenantId}`);
  }, [autoOpen]);

  if (!pending) return null;
  const done = doneCount(pending);
  const name = admins.length > 1 ? admins.find((tenant) => tenant.id === pending.tenantId)?.name : null;

  return (
    <div className="mb-8 flex items-center gap-3.5 rounded-xl border border-tomate-line bg-tomate-lt px-4 py-3.5">
      <ProgressRing done={done} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold">Termine a configuração{name && ` de ${name}`}</p>
        <p className="text-[12px] text-ink-2">
          {done} de {TOTAL} passos. Próximo: {STEP_INFO[pending.steps[resumeIndex(pending)]!.step].next}.
        </p>
      </div>
      <Link href={`/assistente?restaurante=${pending.tenantId}`} className={buttonVariants({ variant: "accent" })}>
        Continuar
      </Link>
    </div>
  );
}

/** Anel "2/9" do aviso da Inbox. */
function ProgressRing({ done }: { done: number }) {
  const radius = 19;
  const length = 2 * Math.PI * radius;
  return (
    <span className="relative flex size-[46px] shrink-0 items-center justify-center" aria-label={`${done} de ${TOTAL} passos`}>
      <svg viewBox="0 0 46 46" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="23" cy="23" r={radius} fill="none" strokeWidth="4" className="stroke-tomate-line" />
        <circle
          cx="23"
          cy="23"
          r={radius}
          fill="none"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={length}
          strokeDashoffset={length * (1 - done / TOTAL)}
          className="stroke-tomate"
        />
      </svg>
      <span className="text-[12px] font-semibold text-tomate-ink tabular-nums">
        {done}/{TOTAL}
      </span>
    </span>
  );
}

/** Entrada "Assistente de configuração" em Configurações, para reabrir (ex.: ligar uma integração pulada). */
export function SetupEntry({ tenantId }: { tenantId: string }) {
  const { request } = useAuth();
  const onboarding = useQuery({ queryKey: ["onboarding", tenantId], queryFn: () => request<OnboardingDto>(`/onboarding/${tenantId}`) });

  return (
    <section className="mb-5 flex items-center gap-3.5 rounded-xl border border-rule px-4 py-3.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2">
        <SparklesIcon className="size-4 text-tomate" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[13px] font-semibold">
          Assistente de configuração
          {onboarding.data && (
            <span className="rounded-sm bg-surface-2 px-1.5 py-px text-[10.5px] font-medium text-ink-2 tabular-nums">
              {doneCount(onboarding.data)} de {TOTAL}
            </span>
          )}
        </p>
        <p className="text-[12px] text-ink-3">Reabra para ligar uma integração pulada.</p>
      </div>
      <Link href={`/assistente?restaurante=${tenantId}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
        Abrir assistente
      </Link>
    </section>
  );
}
