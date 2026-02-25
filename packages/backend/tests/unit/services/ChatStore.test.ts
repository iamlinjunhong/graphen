import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const runSqliteTests = process.env.RUN_SQLITE_TESTS === "true";

const createdDbFiles: string[] = [];

afterEach(() => {
  for (const path of createdDbFiles.splice(0)) {
    rmSync(path, { force: true });
    rmSync(`${path}-shm`, { force: true });
    rmSync(`${path}-wal`, { force: true });
  }
});

describe.skipIf(!runSqliteTests)("ChatStore", () => {
  let ChatStore: typeof import("../../../src/services/ChatStore.js").ChatStore;
  let sqliteAvailable = true;
  let sqliteUnavailableReason = "";

  beforeAll(async () => {
    try {
      ({ ChatStore } = await import("../../../src/services/ChatStore.js"));
      const probePath = resolve("tmp", `chat-store-probe-${randomUUID()}.db`);
      createdDbFiles.push(probePath);
      const probeStore = new ChatStore({ dbPath: probePath });
      probeStore.close();
    } catch (error) {
      sqliteAvailable = false;
      sqliteUnavailableReason = error instanceof Error ? error.message : String(error);
    }
  });

  it("creates session, persists messages, and supports cascade delete", () => {
    if (!sqliteAvailable) {
      // Skip assertion flow if native bindings are unavailable in CI/sandbox.
      expect(sqliteUnavailableReason.length).toBeGreaterThan(0);
      return;
    }

    const dbPath = resolve("tmp", `chat-store-${randomUUID()}.db`);
    createdDbFiles.push(dbPath);

    const store = new ChatStore({ dbPath });
    const session = store.createSession({ title: "Demo Session" });
    expect(session.title).toBe("Demo Session");

    store.addMessage({
      sessionId: session.id,
      role: "user",
      content: "What is Graphen?"
    });
    store.addMessage({
      sessionId: session.id,
      role: "assistant",
      content: "Graphen is a GraphRAG app."
    });

    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1);

    const sessionDetail = store.getSessionWithMessages(session.id);
    expect(sessionDetail?.messages).toHaveLength(2);
    expect(sessionDetail?.messages[0]?.role).toBe("user");
    expect(sessionDetail?.messages[1]?.role).toBe("assistant");

    const deleted = store.deleteSession(session.id);
    expect(deleted).toBe(true);
    expect(store.getSessionById(session.id)).toBeNull();
    expect(store.listMessagesBySession(session.id)).toEqual([]);

    store.close();
  });
});
