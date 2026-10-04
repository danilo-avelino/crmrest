import { type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { SentryGlobalFilter, SentryModule } from "@sentry/nestjs/setup";
import { AuthModule } from "./auth/auth.module.js";
import { type AppRole, type Env, hasRole } from "./config/env.js";
import { ConnectorsModule } from "./connectors/connectors.module.js";
import { CoreModule } from "./core/core.module.js";
import { HealthController } from "./health/health.controller.js";
import { QueuesModule } from "./queues/queues.module.js";
import { RealtimeEmitterModule } from "./realtime/realtime.module.js";
import { ApiRoleModule, GatewayRoleModule, RealtimeRoleModule, WorkerRoleModule } from "./roles.js";

const ROLE_MODULES: Record<Exclude<AppRole, "all">, DynamicModule["imports"]> = {
  api: [AuthModule, ApiRoleModule],
  gateway: [GatewayRoleModule],
  realtime: [RealtimeRoleModule],
  worker: [WorkerRoleModule],
};

@Module({})
export class AppModule {
  /** Monta só os módulos do papel do processo (APP_ROLE, §3.2). */
  static forRole(env: Env): DynamicModule {
    const roles = (Object.keys(ROLE_MODULES) as (keyof typeof ROLE_MODULES)[]).filter((role) => hasRole(env, role));
    return {
      module: AppModule,
      imports: [
        SentryModule.forRoot(),
        CoreModule.forRoot(env),
        QueuesModule.forRoot(env),
        RealtimeEmitterModule,
        ConnectorsModule,
        ...roles.flatMap((role) => ROLE_MODULES[role] ?? []),
      ],
      controllers: [HealthController],
      // Erros não tratados vão para o Sentry (sem SENTRY_DSN, não faz nada) e seguem a resposta padrão do Nest.
      providers: [{ provide: APP_FILTER, useClass: SentryGlobalFilter }],
    };
  }
}
