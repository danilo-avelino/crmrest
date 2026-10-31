import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerModule, ThrottlerStorage } from "@nestjs/throttler";
import { BillingController } from "../billing/billing.controller.js";
import { AuthController } from "./auth.controller.js";
import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { LoginLimitsService } from "./login-limits.service.js";
import { TokensModule } from "./tokens.module.js";

@Module({
  imports: [
    TokensModule,
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 10 }],
      errorMessage: "Muitas tentativas. Aguarde alguns minutos e tente de novo.",
    }),
  ],
  controllers: [AuthController, BillingController],
  providers: [
    AuthService,
    LoginLimitsService,
    // O ThrottlerGuard dos controllers deste módulo conta as tentativas no Redis, no lugar da memória do processo.
    { provide: ThrottlerStorage, useExisting: LoginLimitsService },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
