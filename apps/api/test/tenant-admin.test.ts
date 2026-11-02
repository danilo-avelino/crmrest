import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { RequestAuth } from "../src/auth/auth.decorators.js";
import { adminScope, memberScope } from "../src/settings/tenant-admin.js";

const [A, B, OUTRO] = ["tenant-a", "tenant-b", "tenant-outro"];
const auth: RequestAuth = {
  userId: "user-1",
  mode: "master",
  tenants: [
    { id: A, role: "ADMIN" },
    { id: B, role: "AGENT" },
  ],
  scope: { tenantIds: [A, B], userId: "user-1" },
};

describe("escopo de um restaurante vindo da requisição", () => {
  it("memberScope aceita qualquer restaurante do token e devolve só ele", () => {
    expect(memberScope(auth, A)).toEqual({ tenantIds: [A], userId: "user-1" });
    expect(memberScope(auth, B)).toEqual({ tenantIds: [B], userId: "user-1" });
  });

  it("memberScope recusa restaurante fora do token", () => {
    expect(() => memberScope(auth, OUTRO)).toThrow(ForbiddenException);
    expect(() => memberScope(auth, OUTRO)).toThrow("Sem acesso a este restaurante.");
  });

  it("adminScope só aceita restaurante em que o usuário é admin", () => {
    expect(adminScope(auth, A)).toEqual({ tenantIds: [A], userId: "user-1" });
    expect(() => adminScope(auth, B)).toThrow(ForbiddenException);
    expect(() => adminScope(auth, OUTRO)).toThrow(ForbiddenException);
  });
});
