"use client";

import { Suspense } from "react";
import { RequireContext } from "@/components/auth/require-context";
import { InboxView } from "@/components/inbox/inbox-view";

export default function InboxPage() {
  return (
    <RequireContext>
      <Suspense>
        <InboxView />
      </Suspense>
    </RequireContext>
  );
}
