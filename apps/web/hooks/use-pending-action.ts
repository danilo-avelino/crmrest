"use client"

import { useRef, useState } from "react"

/**
 * Guard de duplo clique (CLAUDE.md §6): enquanto a Promise devolvida pela ação não termina,
 * novas chamadas são ignoradas e `pending` fica true (para mostrar "Carregando…").
 */
export function usePendingAction<A extends unknown[]>(action: ((...args: A) => unknown) | undefined) {
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)

  function run(...args: A) {
    // A ref barra a segunda chamada na hora, antes de o re-render desabilitar o controle.
    if (pendingRef.current) return
    const result = action?.(...args)
    if (!(result instanceof Promise)) return
    pendingRef.current = true
    setPending(true)
    void result.finally(() => {
      pendingRef.current = false
      setPending(false)
    })
  }

  return [run, pending] as const
}
