"use client";

import { useEffect, useState } from "react";

/** Hora atual que se atualiza sozinha, para os tempos relativos ("14 min") não ficarem parados. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
