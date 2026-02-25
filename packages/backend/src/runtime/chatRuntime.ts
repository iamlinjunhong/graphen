import { appConfig } from "../config.js";
import type { ChatStoreLike } from "../services/ChatStore.js";
import { ChatStore } from "../services/ChatStore.js";
import { InMemoryChatStore } from "../services/InMemoryChatStore.js";
import { logger } from "../utils/logger.js";

let chatStoreSingleton: ChatStoreLike | null = null;

export function getChatStoreSingleton(): ChatStoreLike {
  if (chatStoreSingleton) {
    return chatStoreSingleton;
  }

  try {
    chatStoreSingleton = new ChatStore({ dbPath: appConfig.CHAT_DB_PATH });
  } catch (error) {
    logger.warn(
      {
        error: error instanceof Error ? error.message : String(error)
      },
      "SQLite ChatStore unavailable, falling back to in-memory store"
    );
    chatStoreSingleton = new InMemoryChatStore();
  }

  return chatStoreSingleton;
}
