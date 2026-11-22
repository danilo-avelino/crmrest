import { afterEach, describe, expect, it, vi } from "vitest";
import { contextToken, fetchContext, saveContextToken } from "./menu-context";

describe("Link com contexto do WhatsApp (F3-11)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("guarda o token até o pedido entrar", () => {
    const map = new Map<string, string>();
    const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
    saveContextToken("loja", "abc.1.sig", store);
    expect(contextToken("loja", store)).toBe("abc.1.sig");
    saveContextToken("loja", null, store);
    expect(contextToken("loja", store)).toBeNull();
  });

  it("link vencido volta null; o válido traz as escolhas do carrinho", async () => {
    const lines = [{ itemId: "i1", sizeId: null, optionIds: [], halves: [], quantity: 2, note: null }];
    const fetch = vi.fn(async (url: string) => (url.includes("vencido") ? new Response("{}", { status: 404 }) : Response.json({ lines })));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchContext("loja", "vencido")).toBeNull();
    expect(await fetchContext("loja", "ok.1.sig")).toEqual(lines);
    expect(fetch.mock.calls[1]![0]).toBe("/api/public/menu/loja/context?c=ok.1.sig");
  });
});
