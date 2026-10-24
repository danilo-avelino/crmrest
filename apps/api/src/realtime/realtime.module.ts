import { Global, Module } from "@nestjs/common";
import { PresenceService } from "./presence.service.js";
import { RealtimeEmitter } from "./realtime.emitter.js";

@Global()
@Module({
  providers: [RealtimeEmitter, PresenceService],
  exports: [RealtimeEmitter, PresenceService],
})
export class RealtimeEmitterModule {}
