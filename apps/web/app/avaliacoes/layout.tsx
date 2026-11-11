"use client";

import type { ReactNode } from "react";
import { RequireAdminContext } from "@/components/auth/require-context";
import { RatingsShell } from "@/components/reports/ratings-shell";

/** Avaliações: só administradores. Desktop por enquanto. */
export default function RatingsLayout({ children }: { children: ReactNode }) {
  return (
    <RequireAdminContext>
      <RatingsShell>{children}</RatingsShell>
    </RequireAdminContext>
  );
}
