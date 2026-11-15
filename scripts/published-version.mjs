import assert from "node:assert/strict";

// Query the registry directly: npm wrappers may hide recently published versions.
export async function publishedVersion(name, version, integrity, request = fetch) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const response = await request(url, { signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return false;
  assert.equal(response.status, 200, `Cannot check ${name}@${version}: registry HTTP ${response.status}`);
  const metadata = await response.json();
  assert.equal(metadata.name, name, "Registry returned an unexpected package");
  assert.equal(metadata.version, version, "Registry returned an unexpected version");
  assert.equal(metadata.dist?.integrity, integrity,
    `${name}@${version} already exists with different archive bytes; use a new version before publishing`);
  return true;
}
