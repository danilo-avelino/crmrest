import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PaymentCheckout } from "@/components/public-checkout/payment";
import { fetchPublicMenu } from "@/lib/public-menu";

// Pagamento e revisão do checkout (F3-08, W11 a W13): o estado da entrega vem de lib/public-checkout.ts (loadCheckout).
export const metadata: Metadata = { title: "Pagamento", robots: { index: false, follow: false } };

export default async function CheckoutPaymentPage({ params }: PageProps<"/c/[slug]/checkout/pagamento">) {
  const { slug } = await params;
  const menu = await fetchPublicMenu(slug);
  if (!menu) notFound();
  return (
    <main className="flex flex-1 flex-col" style={{ "--menu-accent": menu.store.accentColor } as React.CSSProperties}>
      <PaymentCheckout slug={slug} store={menu.store} />
    </main>
  );
}
