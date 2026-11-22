import type { Metadata } from "next";
import type { ReactNode } from "react";

// Cardápio público: sem login, sempre no tema claro (theme-light) e com a cor de destaque do restaurante.
// Quando a cor for configurável no cadastro, é este o valor de --menu-accent que muda.
export const metadata: Metadata = { robots: { index: true, follow: true } };

export default function PublicMenuLayout({ children }: { children: ReactNode }) {
  return (
    <div className="theme-light flex min-h-dvh flex-col bg-paper text-ink" style={{ "--menu-accent": "#8E2F1B" } as React.CSSProperties}>
      {children}
    </div>
  );
}
