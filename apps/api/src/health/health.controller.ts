import { Controller, Get } from "@nestjs/common";
import { Public } from "../auth/auth.decorators.js";
import { DatabaseService } from "../core/database.service.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";

@Public()
@Controller("health")
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RealtimeEmitter,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  /** Pronto para receber tráfego: banco e Redis (filas e realtime) respondendo. */
  @Get("ready")
  async ready() {
    await this.db.client.$queryRaw`SELECT 1`;
    await this.redis.ping();
    return { status: "ok" };
  }
}
