"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { LoginForm } from "@/components/auth/login-form";
import { TenantChooser } from "@/components/auth/tenant-chooser";

export default function LoginPage() {
  const { session } = useAuth();
  const router = useRouter();

  // Com o restaurante (ou o painel master) escolhido, segue para a Inbox. Se todos os restaurantes estão bloqueados
  // (teste encerrado ou assinatura vencida), não há o que escolher: segue para o pagamento.
  useEffect(() => {
    if (session?.context) router.replace("/inbox");
    else if (session?.tenants.length && session.tenants.every((tenant) => tenant.blockedBy)) router.replace("/assinatura");
  }, [session, router]);

  return (
    <main className="flex min-h-screen">
      <LoginForm />
      <TenantChooser />
    </main>
  );
}
