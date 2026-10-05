"use client"

import { Toast } from "@base-ui/react/toast"
import { CheckIcon } from "lucide-react"
import type { ReactNode } from "react"

// Toast de sucesso do design (board Clientes): pílula escura no rodapé, centralizada, com o check verde.

function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider timeout={4000}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="fixed bottom-7 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  )
}

function ToastList() {
  const { toasts } = Toast.useToastManager()
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      className="flex items-center gap-2.5 rounded-xl border border-[#3D3A34] bg-ink px-5 py-3 shadow-[0_4px_16px_rgba(0,0,0,0.3)] transition-[opacity,translate] duration-200 data-ending-style:translate-y-2 data-ending-style:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0"
    >
      <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-success">
        <CheckIcon className="size-2.5 text-white" strokeWidth={3} aria-hidden />
      </span>
      <Toast.Title className="text-[13px] text-paper" />
    </Toast.Root>
  ))
}

/** Mostra um toast de sucesso, ex.: toast("Cliente atualizado"). */
function useToast() {
  const manager = Toast.useToastManager()
  return (title: string) => void manager.add({ title })
}

export { ToastProvider, useToast }
