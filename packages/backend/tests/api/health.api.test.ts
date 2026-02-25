import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHealthRouter } from "../../src/routes/health.js";

describe("health api", () => {
  it("returns ok when dependencies are healthy", async () => {
    const app = express();
    app.use(
      "/api/health",
      createHealthRouter({
        checkNeo4j: async () => "ok",
        checkLlm: async () => "ok",
        startTime: Date.now() - 5_000
      })
    );

    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.checks.neo4j).toBe("ok");
    expect(response.body.checks.llm).toBe("ok");
    expect(response.body.uptimeSec).toBeGreaterThanOrEqual(5);
    expect(response.body.memoryUsage.rss).toBeGreaterThan(0);
  });

  it("returns degraded when one dependency fails", async () => {
    const app = express();
    app.use(
      "/api/health",
      createHealthRouter({
        checkNeo4j: async () => "failed",
        checkLlm: async () => "not_configured"
      })
    );

    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("degraded");
    expect(response.body.checks).toEqual({
      neo4j: "failed",
      llm: "not_configured"
    });
  });
});
