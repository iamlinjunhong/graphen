import type { ChatStoreLike } from "../services/chatStoreTypes.js";
import { InMemoryChatStore } from "../services/InMemoryChatStore.js";
import type { PgChatStoreLike } from "../services/PgChatStore.js";
import { PgChatStore } from "../services/PgChatStore.js";
import { runtimePgRequired } from "./runtimeMode.js";

let chatStoreSingleton: ChatStoreLike | null = null;
let pgChatStoreSingleton: PgChatStoreLike | null = null;

export function getChatStoreSingleton(): ChatStoreLike {
  if (chatStoreSingleton) {
    return chatStoreSingleton;
  }

  if (runtimePgRequired()) {
    chatStoreSingleton = getPgChatStoreSingleton();
    return chatStoreSingleton;
  }

  chatStoreSingleton = new InMemoryChatStore();

  return chatStoreSingleton;
}

export function getPgChatStoreSingleton(): PgChatStoreLike {
  if (!pgChatStoreSingleton) {
    pgChatStoreSingleton = new PgChatStore();
  }
  return pgChatStoreSingleton;
}
