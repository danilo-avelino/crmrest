import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createTestApp } from "./helpers.js";

describe("health", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("responde vivo", async () => {
    await request(app.getHttpServer()).get("/api/health/live").expect(200, { status: "ok" });
  });

  it("responde pronto quando o banco atende", async () => {
    await request(app.getHttpServer()).get("/api/health/ready").expect(200, { status: "ok" });
  });
});
