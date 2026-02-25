import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createConfigRouter } from "../../src/routes/config.js";

describe("config api", () => {
  it("supports get/put config and returns model list", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/api/config",
      createConfigRouter({
        checkNeo4j: async () => "ok",
        checkLlm: async () => "failed"
      })
    );

    const getBeforeResponse = await request(app).get("/api/config");
    expect(getBeforeResponse.status).toBe(200);
    expect(getBeforeResponse.body.config.nodeEnv).toBeDefined();
    expect(getBeforeResponse.body.config.corsOrigin).toBeDefined();

    const putResponse = await request(app).put("/api/config").send({
      corsOrigin: "http://localhost:3999",
      maxUploadSize: 1024,
      rateLimitMax: 10,
      logLevel: "debug"
    });
    expect(putResponse.status).toBe(200);
    expect(putResponse.body.message).toBe("Config update accepted");

    const getAfterResponse = await request(app).get("/api/config");
    expect(getAfterResponse.status).toBe(200);
    expect(getAfterResponse.body.config.corsOrigin).toBe("http://localhost:3999");
    expect(getAfterResponse.body.config.maxUploadSize).toBe(1024);
    expect(getAfterResponse.body.config.rateLimitMax).toBe(10);
    expect(getAfterResponse.body.config.logLevel).toBe("debug");

    const modelsResponse = await request(app).get("/api/config/models");
    expect(modelsResponse.status).toBe(200);
    expect(modelsResponse.body.models.chat.length).toBeGreaterThan(0);
    expect(modelsResponse.body.models.embedding.length).toBeGreaterThan(0);
  });

  it("returns connection test result", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      "/api/config",
      createConfigRouter({
        checkNeo4j: async () => "failed",
        checkLlm: async () => "not_configured"
      })
    );

    const response = await request(app).post("/api/config/test-connection").send({});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      neo4j: "failed",
      llm: "not_configured"
    });
  });
});
