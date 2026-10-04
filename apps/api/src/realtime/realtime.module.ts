import { Global, Module } from "@nestjs/common";
import { RealtimeEmitter } from "./realtime.emitter.js";

@Global()
@Module({
  providers: [RealtimeEmitter],
  exports: [RealtimeEmitter],
})
export class RealtimeEmitterModule {}
