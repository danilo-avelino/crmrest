import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MyAccount } from "@/components/public-checkout/my-account";
import { fetchPublicMenu } from "@/lib/public-menu";
import { menuThemeStyle } from "@/lib/menu-theme";

// Minha conta (W16) e Pedidos sem identificação (W17), F3-09.
export const metadata: Metadata = { title: "Minha conta", robots: { index: false, follow: false } };

export default async function AccountPage({ params }: PageProps<"/c/[slug]/conta">) {
  const { slug } = await params;
  const menu = await fetchPublicMenu(slug);
  if (!menu) notFound();
  return (
    <main className="flex flex-1 flex-col" style={menuThemeStyle(menu.store)}>
      <MyAccount slug={slug} storeName={menu.store.name} />
    </main>
  );
}
