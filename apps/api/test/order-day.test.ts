import { describe, expect, it } from "vitest";
import { startOfOrderDay } from "../src/automations/automation.js";

describe("dia dos pedidos vira às 6h de Brasília", () => {
  it.each([
    ["2026-11-15T23:55:00-03:00", "2026-11-15T00:00:00-03:00"],
    ["2026-11-16T00:17:00-03:00", "2026-11-15T00:00:00-03:00"],
    ["2026-11-16T05:59:00-03:00", "2026-11-15T00:00:00-03:00"],
    ["2026-11-16T06:00:00-03:00", "2026-11-16T00:00:00-03:00"],
    ["2026-11-16T12:00:00-03:00", "2026-11-16T00:00:00-03:00"],
  ])("%s começa em %s", (now, start) => expect(startOfOrderDay(new Date(now))).toEqual(new Date(start)));
});
