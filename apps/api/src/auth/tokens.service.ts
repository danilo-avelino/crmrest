import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { TenantRole } from "@dishdesk/database/enums";
import { Inject, Injectable } from "@nestjs/common";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { ENV, type Env } from "../config/env.js";
import type { RequestAuth } from "./auth.decorators.js";

const AccessClaims = z.object({
  sub: z.uuid(),
  mode: z.enum(["tenant", "master"]),
  tenants: z.array(z.object({ id: z.uuid(), role: z.enum(TenantRole) })),
});

@Injectable()
export class TokensService {
  private readonly secret: Uint8Array;

  constructor(@Inject(ENV) env: Env) {
    this.secret = new TextEncoder().encode(env.JWT_SECRET);
  }

  signAccess(auth: Omit<RequestAuth, "scope">): Promise<string> {
    return new SignJWT({ mode: auth.mode, tenants: auth.tenants })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(auth.userId)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(this.secret);
  }

  async verifyAccess(token: string): Promise<RequestAuth> {
    const { payload } = await jwtVerify(token, this.secret, { algorithms: ["HS256"] });
    const claims = AccessClaims.parse(payload);
    return {
      userId: claims.sub,
      mode: claims.mode,
      tenants: claims.tenants,
      scope: { tenantIds: claims.tenants.map((t) => t.id), userId: claims.sub },
    };
  }
}

// Refresh token opaco: "<userId>.<sessionId>.<segredo>". O banco guarda só o sha256 do segredo.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newRefreshSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function sameHash(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function formatRefreshToken(userId: string, sessionId: string, secret: string): string {
  return `${userId}.${sessionId}.${secret}`;
}

export function parseRefreshToken(value: string | undefined) {
  const [userId, sessionId, secret, ...rest] = value?.split(".") ?? [];
  if (!userId || !sessionId || !secret || rest.length || !UUID.test(userId) || !UUID.test(sessionId)) return null;
  return { userId, sessionId, secret };
}
