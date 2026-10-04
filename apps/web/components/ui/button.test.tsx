import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Button } from "./button"

afterEach(cleanup)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("Button", () => {
  it("barra o duplo clique e mostra Carregando até a ação assíncrona terminar", async () => {
    const action = deferred()
    const onClick = vi.fn(() => action.promise)
    render(<Button onClick={onClick}>Enviar</Button>)
    const button = screen.getByRole("button")

    // Dois cliques antes de o React re-renderizar: só a ref pode barrar o segundo.
    act(() => {
      button.click()
      button.click()
    })
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(button.textContent).toBe("Carregando…")
    expect(button.getAttribute("aria-busy")).toBe("true")
    expect(button.hasAttribute("data-disabled")).toBe(true)

    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)

    await act(async () => {
      action.resolve()
      await action.promise
    })
    expect(button.textContent).toBe("Enviar")
    expect(button.hasAttribute("data-disabled")).toBe(false)

    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it("loading controlado mostra Carregando e não dispara o clique", () => {
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Entrar
      </Button>
    )
    const button = screen.getByRole("button")
    expect(button.textContent).toBe("Carregando…")

    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it("clique síncrono não entra em carregamento", () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Atribuir</Button>)
    const button = screen.getByRole("button")

    fireEvent.click(button)
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(2)
    expect(button.textContent).toBe("Atribuir")
  })
})
