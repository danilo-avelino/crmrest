"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { LoginForm } from "@/components/auth/login-form";
import { TenantChooser } from "@/components/auth/tenant-chooser";

export default function LoginPage() {
  const { session } = useAuth();
  const router = useRouter();

  // Com o restaurante (ou o painel master) escolhido, segue para a Inbox.
  useEffect(() => {
    if (session?.context) router.replace("/inbox");
  }, [session, router]);

  return (
    <main className="flex min-h-screen">
      <LoginForm />
      <TenantChooser />
    </main>
  );
}
