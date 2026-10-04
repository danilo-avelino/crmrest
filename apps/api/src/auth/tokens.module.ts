import { Module } from "@nestjs/common";
import { TokensService } from "./tokens.service.js";

@Module({
  providers: [TokensService],
  exports: [TokensService],
})
export class TokensModule {}
