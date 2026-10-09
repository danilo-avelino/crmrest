import { createPrismaClient, type PrismaClient, type TenantScope, type TenantTx, withTenants } from "@dishdesk/database";
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { ENV, type Env } from "../config/env.js";

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(ENV) env: Env) {
    this.client = createPrismaClient(env.DATABASE_URL);
  }

  async onModuleInit(): Promise<void> {
    // A aplicação nunca pode rodar com uma role que ignora a RLS (§3.3).
    const [role] = await this.client.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    if (!role || role.rolsuper || role.rolbypassrls) {
      throw new Error("DATABASE_URL usa uma role que ignora a RLS; use a role da aplicação.");
    }
  }

  withTenants<T>(scope: TenantScope, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenants(this.client, scope, fn);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
