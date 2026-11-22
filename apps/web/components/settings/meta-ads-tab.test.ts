import { DEFAULT_MENU_STORE } from "@dishdesk/shared";
import { describe, expect, it } from "vitest";
import { metaAdsPayload } from "./meta-ads-tab";

describe("Meta Ads (C3, F7-03)", () => {
  it("aceita só números no Pixel ID e tira os espaços", () => {
    expect(metaAdsPayload(DEFAULT_MENU_STORE, " 1234 5678 9012 ", "TEST1")).toEqual({ ok: true, body: { ...DEFAULT_MENU_STORE, metaPixelId: "123456789012", metaTestEventCode: "TEST1" } });
    expect(metaAdsPayload(DEFAULT_MENU_STORE, "abc123", "")).toEqual({ ok: false, error: "O Pixel ID tem só números (8 a 20)." });
  });

  it("campo vazio tira o Pixel e o código", () => {
    const result = metaAdsPayload({ ...DEFAULT_MENU_STORE, metaPixelId: "12345678", metaTestEventCode: "X" }, "", "");
    expect(result).toEqual({ ok: true, body: DEFAULT_MENU_STORE });
  });
});
