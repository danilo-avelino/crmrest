import { Suspense } from "react";
import { ClientList } from "@/components/clients/client-list";

export default function ClientsPage() {
  return (
    <Suspense>
      <ClientList />
    </Suspense>
  );
}
