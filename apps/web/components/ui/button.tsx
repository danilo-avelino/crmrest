"use client"

import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { LoaderCircleIcon } from "lucide-react"
import type { MouseEvent } from "react"
import { usePendingAction } from "@/hooks/use-pending-action"

// Estilos e alturas (26/30/36/42px) do design: Sistema de Design + telas.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 active:not-aria-[haspopup]:translate-y-px data-disabled:cursor-not-allowed data-disabled:opacity-55 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // primário: Responder, Entrar
        default: "bg-primary text-primary-foreground hover:bg-primary/85",
        // destaque tomate: Resolver, Enviar, Nova campanha
        accent: "bg-tomate text-white hover:bg-tomate/90",
        // secundário: Atribuir, Continuar com Google, Pausar
        outline: "border-border bg-surface text-ink hover:bg-surface-2 aria-expanded:bg-surface-2",
        secondary:
          "border-border bg-secondary text-secondary-foreground hover:bg-rule/60 aria-expanded:bg-rule/60",
        // Cancelar, Falar com o suporte
        ghost: "text-ink-2 hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        // Cancelar campanha
        destructive:
          "border-destructive text-destructive hover:bg-tomate-lt focus-visible:border-destructive focus-visible:ring-destructive/20",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 gap-1.5 px-4 text-[13px]",
        xs: "h-[26px] gap-1 rounded-sm px-[9px] text-[11px] [&_svg:not([class*='size-'])]:size-3",
        sm: "h-[30px] gap-1 rounded-md px-3 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-[42px] gap-2 px-5 text-[13.5px]",
        icon: "size-9",
        "icon-xs": "size-[26px] rounded-sm [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-[30px] rounded-md [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-[42px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonProps = Omit<ButtonPrimitive.Props, "onClick"> &
  VariantProps<typeof buttonVariants> & {
    /** Carregamento controlado por fora, ex.: o formulário que o botão envia. */
    loading?: boolean
    /**
     * Se retornar uma Promise, o botão mostra "Carregando…" e ignora novos cliques até ela
     * terminar (guard de duplo clique, CLAUDE.md §6).
     */
    onClick?: (event: MouseEvent<HTMLButtonElement>) => unknown
  }

function Button({
  className,
  variant = "default",
  size = "default",
  loading = false,
  disabled,
  onClick,
  children,
  ...props
}: ButtonProps) {
  const [handleClick, pending] = usePendingAction(onClick)
  const busy = loading || pending

  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled || busy}
      // Mantém o foco do teclado no botão enquanto carrega.
      focusableWhenDisabled={busy}
      aria-busy={busy || undefined}
      onClick={handleClick}
      {...props}
    >
      {busy ? (
        <>
          <LoaderCircleIcon className="animate-spin" aria-hidden />
          Carregando…
        </>
      ) : (
        children
      )}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants }
