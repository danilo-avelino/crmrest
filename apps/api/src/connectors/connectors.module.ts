import { Global, Module } from "@nestjs/common";
import { ConnectorsService } from "./connectors.service.js";

@Global()
@Module({
  providers: [ConnectorsService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
