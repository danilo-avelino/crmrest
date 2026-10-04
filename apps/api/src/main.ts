import "./instrument.js";
import { NestFactory } from "@nestjs/core";
import { configureApp } from "./app.js";
import { AppModule } from "./app.module.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv();
// rawBody: o webhook da Meta valida a assinatura sobre o corpo exato recebido.
const app = configureApp(await NestFactory.create(AppModule.forRole(env), { rawBody: true, bufferLogs: true }), env);
await app.listen(env.PORT);
