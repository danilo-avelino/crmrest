import { type DynamicModule, Global, Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "./database.service.js";
import { loggingOptions } from "./logging.js";

@Global()
@Module({})
export class CoreModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: CoreModule,
      imports: [LoggerModule.forRoot(loggingOptions(env))],
      providers: [{ provide: ENV, useValue: env }, DatabaseService],
      exports: [ENV, DatabaseService],
    };
  }
}
