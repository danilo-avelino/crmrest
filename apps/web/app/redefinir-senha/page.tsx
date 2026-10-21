"use client";

import dynamic from "next/dynamic";
import { AuthAside } from "@/components/auth/auth-aside";

// O token vem no fragmento do endereço (#access_token=...), que só o navegador enxerga.
const ResetPasswordForm = dynamic(() => import("@/components/auth/reset-password-form").then((m) => m.ResetPasswordForm), {
  ssr: false,
  loading: () => <section className="w-[520px] shrink-0 bg-paper" />,
});

/** Destino do link de "Esqueceu?" no e-mail (Supabase Auth). */
export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-screen">
      <ResetPasswordForm />
      <AuthAside
        title="Todo o atendimento na sua mesa"
        subtitle="WhatsApp, Instagram e iFood no mesmo lugar."
        items={[]}
      />
    </main>
  );
}
