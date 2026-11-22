import { describe, expect, it } from "vitest";
import { attributionFrom, browserSessionId, rememberAttribution } from "./attribution";

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe("origem da visita (F7-02)", () => {
  it("lê UTMs, fbclid (vira fbc no formato da Meta), _fbp e o referrer externo", () => {
    const url = new URL("https://app.dishdesk.com.br/c/loja?utm_source=instagram&utm_campaign=natal&fbclid=ABC&x=1");
    const out = attributionFrom(url, "https://l.instagram.com/x?y=1", "a=1; _fbp=fb.1.123.456", 1_700_000_000_000);
    expect(out).toEqual({ utm_source: "instagram", utm_campaign: "natal", fbclid: "ABC", fbc: "fb.1.1700000000000.ABC", fbp: "fb.1.123.456", referrer: "https://l.instagram.com/x" });
  });

  it("referrer do próprio cardápio não conta; sem fbclid usa o cookie _fbc", () => {
    const url = new URL("https://app.dishdesk.com.br/c/loja");
    expect(attributionFrom(url, "https://app.dishdesk.com.br/c/loja/conta", "_fbc=fb.1.9.XYZ", 0)).toEqual({ fbc: "fb.1.9.XYZ" });
  });

  it("primeiro toque: guarda a 1ª origem por 30 dias e não troca por uma visita direta", () => {
    const store = memory();
    const day = 24 * 60 * 60 * 1000;
    expect(rememberAttribution("loja", { utm_source: "instagram" }, 0, store)).toEqual({ utm_source: "instagram" });
    expect(rememberAttribution("loja", { utm_source: "google" }, 5 * day, store)).toEqual({ utm_source: "instagram" });
    expect(rememberAttribution("loja", {}, 40 * day, store)).toEqual({});
    expect(rememberAttribution("loja", { utm_source: "google" }, 41 * day, store)).toEqual({ utm_source: "google" });
  });

  it("o id anônimo do navegador se mantém", () => {
    const store = memory();
    const first = browserSessionId(store);
    expect(first.length).toBeGreaterThanOrEqual(8);
    expect(browserSessionId(store)).toBe(first);
  });
});
