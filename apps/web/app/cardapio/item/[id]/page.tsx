import { Suspense } from "react";
import { ItemEditor } from "@/components/menu/item-editor";

export default async function MenuItemPage({ params }: PageProps<"/cardapio/item/[id]">) {
  const { id } = await params;
  return (
    <Suspense>
      <ItemEditor key={id} id={id} />
    </Suspense>
  );
}
