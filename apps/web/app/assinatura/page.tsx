"use client";

import { Suspense } from "react";
import { SubscriptionWall } from "@/components/auth/subscription-wall";

export default function SubscriptionPage() {
  return (
    <Suspense>
      <SubscriptionWall />
    </Suspense>
  );
}
