import { resetDb } from "../../db/client.js";
import { _resetWorkspaceRootForTest } from "../../db/internal/config.js";
import { _resetApiKeyCacheForTest } from "./api-key.js";
import { _resetAuthFailuresForTest } from "./security.js";
import { _resetSnapshotEtagsForTest } from "./snapshot-etag.js";

/**
 * Reset shared process state for tests, including connections, configuration, API keys,
 * authentication counters, and snapshot tags. Register new process-lifetime resetters here.
 * Production callers should use each cache's normal invalidation rules.
 */
export function _resetProcessStateForTest(): void {
  resetDb();
  _resetWorkspaceRootForTest();
  _resetApiKeyCacheForTest();
  _resetAuthFailuresForTest();
  _resetSnapshotEtagsForTest();
}
