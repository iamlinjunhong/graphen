import { appConfig } from "../config.js";

export function runtimePgRequired(): boolean {
  if (appConfig.NODE_ENV !== "test") {
    return true;
  }
  return appConfig.RUNTIME_PG_REQUIRED;
}

export function graphSyncEnabled(): boolean {
  if (!appConfig.GRAPH_SYNC_ENABLED) {
    return false;
  }
  return runtimePgRequired();
}
