import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { IS_PUBLIC, type RequestAuth } from "./auth.decorators.js";
import { TokensService } from "./tokens.service.js";

/** Exige access token válido em toda rota HTTP que não for @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;

    const request = context.switchToHttp().getRequest<Request & { auth?: RequestAuth }>();
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new UnauthorizedException();
    try {
      request.auth = await this.tokens.verifyAccess(header.slice("Bearer ".length));
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }
}
