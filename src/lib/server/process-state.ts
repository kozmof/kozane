import { resetDb } from "../../db/client.js";
import { _resetWorkspaceRootForTest } from "../../db/internal/config.js";
import { _resetApiKeyCacheForTest } from "./api-key.js";
import { _resetAuthFailuresForTest } from "./security.js";
import { _resetSnapshotEtagsForTest } from "./snapshot-etag.js";

/**
 * Everything this process remembers between requests, and the one call that forgets it.
 *
 * Five modules hold state for the life of the server, each for its own good reason: the
 * database handle, the resolved workspace root and its parsed config, the parsed API key
 * against the file it came from, the authentication failure windows, and the snapshot tags
 * against the database signature they were computed under. None of them is a mistake — they
 * are what keeps a once-a-second poll from reopening a database, re-reading a key file and
 * re-parsing a config on every tick.
 *
 * What was a mistake is that there was no way to name the set. Each module grew its own
 * `_resetXForTest`, and a test that wanted a clean process had to know which of the five
 * applied to it — so tests reset the two or three they had thought of, and the fourth
 * carried over. That is not a hypothetical: the caches are validated against the
 * filesystem, so a stale entry usually survives being wrong, which is exactly the failure
 * that does not announce itself.
 *
 * So this is the list, in one place. A module that grows process-lifetime state adds its
 * resetter here and every test that already calls this is covered by it. The individual
 * `_resetXForTest` functions stay exported for the tests that are *about* one cache and
 * want to move only it.
 *
 * Not production API. Nothing in a running server should want this — the state it clears is
 * the state that makes the server fast, and the caches that must respond to an outside
 * change already validate themselves against the thing they were derived from.
 */
export function _resetProcessStateForTest(): void {
  resetDb();
  _resetWorkspaceRootForTest();
  _resetApiKeyCacheForTest();
  _resetAuthFailuresForTest();
  _resetSnapshotEtagsForTest();
}
