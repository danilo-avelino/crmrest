import { Global, Module } from "@nestjs/common";
import { ConnectorsService } from "./connectors.service.js";
import { IfoodAuthService } from "./ifood-auth.service.js";

@Global()
@Module({
  providers: [ConnectorsService, IfoodAuthService],
  exports: [ConnectorsService, IfoodAuthService],
})
export class ConnectorsModule {}
