"use client";

import { RequireContext } from "@/components/auth/require-context";
import { InboxView } from "@/components/inbox/inbox-view";

export default function InboxPage() {
  return (
    <RequireContext>
      <InboxView />
    </RequireContext>
  );
}
