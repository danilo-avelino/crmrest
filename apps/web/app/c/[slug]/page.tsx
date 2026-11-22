import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MenuView } from "@/components/public-menu/menu-view";
import { StoreHero } from "@/components/public-menu/store-hero";
import { fetchPublicMenu } from "@/lib/public-menu";

// ISR: a página é gerada no servidor e refeita no máximo a cada 30 s (esgotado e horário aparecem logo). O Next exige
// um número literal aqui (o mesmo MENU_REVALIDATE_SECONDS de lib/public-menu.ts).
export const revalidate = 30;

export async function generateMetadata({ params }: PageProps<"/c/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const menu = await fetchPublicMenu(slug).catch(() => null);
  return menu ? { title: `${menu.store.name} · cardápio`, description: `Peça pelo cardápio online de ${menu.store.name}.` } : { title: "Loja não encontrada" };
}

export default async function PublicMenuPage({ params }: PageProps<"/c/[slug]">) {
  const { slug } = await params;
  const menu = await fetchPublicMenu(slug);
  if (!menu) notFound();
  return (
    <main className="flex-1" style={{ "--menu-accent": menu.store.accentColor } as React.CSSProperties}>
      <StoreHero store={menu.store} slug={slug} />
      <MenuView slug={slug} menu={menu} />
      <footer className="px-4 pt-2 pb-28 text-center text-[12px] text-ink-3">
        Feito com <span className="font-semibold text-ink-2">Dish Desk</span>
      </footer>
    </main>
  );
}
