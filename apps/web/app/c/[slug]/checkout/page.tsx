import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Checkout } from "@/components/public-checkout/checkout";
import { fetchPublicMenu } from "@/lib/public-menu";

// Checkout (F3-07): identificação, entrega ou retirada e endereço. Pagamento e revisão são o F3-08 (./pagamento).
export const metadata: Metadata = { title: "Finalizar pedido", robots: { index: false, follow: false } };

export default async function CheckoutPage({ params, searchParams }: PageProps<"/c/[slug]/checkout">) {
  const { slug } = await params;
  const { agendar } = await searchParams;
  const menu = await fetchPublicMenu(slug);
  if (!menu) notFound();
  return (
    <main className="flex flex-1 flex-col" style={{ "--menu-accent": menu.store.accentColor } as React.CSSProperties}>
      <Checkout slug={slug} store={menu.store} scheduleRequested={agendar === "1"} />
    </main>
  );
}
