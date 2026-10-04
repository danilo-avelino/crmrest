import type { INestApplicationContext } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import type { Server, ServerOptions } from "socket.io";
import type { Env } from "../config/env.js";

/** Socket.IO com adapter Redis: eventos chegam a todas as instâncias do papel realtime (§3.2). */
export class RedisIoAdapter extends IoAdapter {
  private readonly pub: Redis;
  private readonly sub: Redis;

  constructor(
    app: INestApplicationContext,
    private readonly env: Env,
  ) {
    super(app);
    this.pub = new Redis(env.REDIS_URL);
    this.sub = this.pub.duplicate();
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: this.env.WEB_ORIGIN },
    } as ServerOptions) as Server;
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }

  override async close(server: Server): Promise<void> {
    await super.close(server);
    await Promise.all([this.pub.quit(), this.sub.quit()]);
  }
}
