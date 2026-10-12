"use client";

import { Suspense } from "react";
import { BillingTab } from "@/components/settings/billing-tab";

export default function BillingPage() {
  return (
    <Suspense>
      <BillingTab />
    </Suspense>
  );
}
