"use client";

import type { ReactNode } from "react";
import { RequireAdminContext } from "@/components/auth/require-context";
import { SettingsShell } from "@/components/settings/settings-shell";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAdminContext>
      <SettingsShell>{children}</SettingsShell>
    </RequireAdminContext>
  );
}
