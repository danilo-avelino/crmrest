import { Global, Module } from "@nestjs/common";
import { DefenseService } from "./defense.service.js";
import { JevClient } from "./jev.client.js";

/** Defesa da API: vale em todos os papéis que recebem HTTP (o middleware é montado no configureApp). */
@Global()
@Module({ providers: [DefenseService, JevClient], exports: [DefenseService] })
export class DefenseModule {}
