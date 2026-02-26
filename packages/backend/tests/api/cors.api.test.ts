import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../../src/server.js";

describe("CORS configuration", () => {
  it("exposes x-document-id and pagination headers in Access-Control-Expose-Headers", async () => {
    const response = await request(app)
      .options("/api/documents/upload")
      .set("Origin", "http://localhost:5173")
      .set("Access-Control-Request-Method", "POST");

    const exposed = response.headers["access-control-expose-headers"] ?? "";
    expect(exposed).toContain("x-document-id");
    expect(exposed).toContain("x-total-count");
    expect(exposed).toContain("x-page");
    expect(exposed).toContain("x-page-size");
  });

  it("includes exposed headers on actual requests", async () => {
    const response = await request(app)
      .get("/api/health")
      .set("Origin", "http://localhost:5173");

    const exposed = response.headers["access-control-expose-headers"] ?? "";
    expect(exposed).toContain("x-document-id");
  });
});
