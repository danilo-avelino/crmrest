import { Suspense } from "react";
import { DuplicatesView } from "@/components/clients/duplicates-view";

export default function DuplicatesPage() {
  return (
    <Suspense>
      <DuplicatesView />
    </Suspense>
  );
}
