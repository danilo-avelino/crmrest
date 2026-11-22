import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OrderConfirmation } from "@/components/public-checkout/order-confirmation";
import { fetchPublicMenu } from "@/lib/public-menu";

// Pedido confirmado (F3-08, W15): número, previsão ou horário, resumo e "Falar com a loja"; a linha do tempo, a
// avaliação e o "Pedir de novo" vieram no F3-09.
export const metadata: Metadata = { title: "Pedido confirmado", robots: { index: false, follow: false } };

export default async function OrderPage({ params }: PageProps<"/c/[slug]/pedido/[id]">) {
  const { slug, id } = await params;
  const menu = await fetchPublicMenu(slug);
  if (!menu) notFound();
  return (
    <main className="flex flex-1 flex-col" style={{ "--menu-accent": menu.store.accentColor } as React.CSSProperties}>
      <OrderConfirmation slug={slug} orderId={id} storeName={menu.store.name} />
    </main>
  );
}
