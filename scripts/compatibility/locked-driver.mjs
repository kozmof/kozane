import assert from "node:assert/strict";
/** Select the exact locked dependency graph, including platform-specific native artifacts.
 * @param {string} lock
 * @param {string} root
 */
export function lockedDriver(lock, root) {
  /** @param {string} section */
  function blocks(section) {
    return new Map(
      section
        .split(/\n(?= {2}\S)/)
        .filter((entry) => entry.trim())
        .map((entry) => {
          const match = entry.match(/^\s{2}(.+?):(?:\n| \{\})/);
          assert.ok(match, "Invalid locked package block");
          const key = match[1].replace(/^'|'$/g, "");
          return [key, entry.replace(/^\n/, "").trimEnd()];
        }),
    );
  }
  const packages = blocks(lock.split("\npackages:\n")[1].split("\nsnapshots:\n")[0]);
  const snapshots = blocks(lock.split("\nsnapshots:\n")[1]);
  /** @type {Set<string>} */
  const visited = new Set();
  /** @param {string} key */
  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const snapshot = snapshots.get(key);
    assert.ok(snapshot, `Missing driver snapshot ${key}`);
    for (const match of snapshot.matchAll(/^ {6}('[^']+'|[^ :]+): (.+)$/gm)) {
      const name = match[1].replace(/^'|'$/g, "");
      const reference = match[2].replace(/^'|'$/g, "");
      visit(`${name}@${reference}`);
    }
  }
  visit(root);
  return {
    packages: [...visited]
      .map((key) => {
        const metadata = packages.get(key.replace(/\(.*$/, ""));
        assert.ok(metadata, `Missing driver artifact ${key}`);
        return metadata;
      })
      .join("\n"),
    snapshots: [...visited].map((key) => snapshots.get(key)).join("\n"),
  };
}
