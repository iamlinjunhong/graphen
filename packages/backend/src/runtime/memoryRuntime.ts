import type { MemoryEntryStoreLike } from "@graphen/shared";
import { PgMemoryStore } from "../services/PgMemoryStore.js";

let pgMemoryEntryStoreSingleton: MemoryEntryStoreLike | null = null;

export function getPgMemoryEntryStoreSingleton(): MemoryEntryStoreLike {
  if (pgMemoryEntryStoreSingleton) {
    return pgMemoryEntryStoreSingleton;
  }

  pgMemoryEntryStoreSingleton = new PgMemoryStore();
  return pgMemoryEntryStoreSingleton;
}
