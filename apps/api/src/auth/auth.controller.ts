import { type AuthSession, LoginRequest, SelectContextRequest } from "@comanda/shared";
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { ZodPipe } from "../common/zod.pipe.js";
import { ENV, type Env } from "../config/env.js";
import { CurrentAuth, Public, type RequestAuth } from "./auth.decorators.js";
import { AuthService } from "./auth.service.js";

const SESSION_COOKIE = "comanda_session";
const SESSION_COOKIE_PATH = "/api/auth";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(
    @Body(new ZodPipe(LoginRequest)) body: { email: string; password: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSession> {
    const { refreshToken, session } = await this.auth.login(body.email, body.password, request.headers["user-agent"]);
    response.cookie(SESSION_COOKIE, refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.env.NODE_ENV === "production",
      path: SESSION_COOKIE_PATH,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    return session;
  }

  @Public()
  @Post("context")
  @HttpCode(200)
  selectContext(
    @Body(new ZodPipe(SelectContextRequest)) body: SelectContextRequest,
    @Req() request: Request,
  ): Promise<AuthSession> {
    return this.auth.selectContext(sessionCookie(request), body);
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  refresh(@Req() request: Request): Promise<AuthSession> {
    return this.auth.refresh(sessionCookie(request));
  }

  @Public()
  @Post("logout")
  @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.auth.logout(sessionCookie(request));
    response.clearCookie(SESSION_COOKIE, { path: SESSION_COOKIE_PATH });
  }

  @Get("me")
  me(@CurrentAuth() auth: RequestAuth) {
    return { userId: auth.userId, mode: auth.mode, tenants: auth.tenants };
  }
}

function sessionCookie(request: Request): string | undefined {
  const cookies = request.cookies as Record<string, string> | undefined;
  return cookies?.[SESSION_COOKIE];
}
