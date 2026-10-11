"use client";

import { BILLING_PLANS } from "@dishdesk/shared";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AuthAside } from "@/components/auth/auth-aside";
import { useAuth } from "@/components/auth/auth-provider";
import { SignupForm } from "@/components/auth/signup-form";
import { currencyWhole } from "@/lib/format";

const price = (plan: keyof typeof BILLING_PLANS) => currencyWhole(BILLING_PLANS[plan].amountCents / 100);

export default function SignupPage() {
  const { session } = useAuth();
  const router = useRouter();

  // O cadastro já entra no restaurante novo: segue para a Inbox.
  useEffect(() => {
    if (session?.context) router.replace("/inbox");
  }, [session, router]);

  return (
    <main className="flex min-h-screen">
      <SignupForm />
      <AuthAside
        title="Todo o atendimento na sua mesa"
        subtitle={`Depois do teste, ${price("monthly")} por mês no cartão ou ${price("annual")} por ano no Pix.`}
        items={[
          "WhatsApp, Instagram e iFood na mesma caixa de entrada",
          "Pedido do cliente ao lado da conversa",
          "Mensagens automáticas no tom do seu restaurante",
          "Sem cartão de crédito para começar",
        ]}
      />
    </main>
  );
}
