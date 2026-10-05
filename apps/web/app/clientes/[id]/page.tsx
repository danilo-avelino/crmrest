import { ClientDetail } from "@/components/clients/client-detail";

export default async function ClientPage({ params }: PageProps<"/clientes/[id]">) {
  const { id } = await params;
  return <ClientDetail key={id} id={id} />;
}
