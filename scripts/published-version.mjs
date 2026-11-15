import * as http from "node:http";
import assert from "node:assert/strict";

// Respect the same proxy environment as npm in managed networks.
http.setGlobalProxyFromEnv?.();

// Query the registry directly: npm wrappers may hide recently published versions.
export async function publishedVersion(name, version, integrity, request = fetch) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await request(url, { signal: AbortSignal.timeout(30_000) });
      break;
    } catch (cause) {
      if (attempt < 2 && cause.cause?.code === "EAI_AGAIN") continue;
      throw new Error(
        "Cannot check " + name + "@" + version + ": " +
        (cause.cause?.code ?? cause.message) +
        ". Check registry connectivity and proxy settings; no publication was attempted for this archive.",
        { cause },
      );
    }
  }
  if (response.status === 404) return false;
  assert.equal(
    response.status,
    200,
    `Cannot check ${name}@${version}: registry HTTP ${response.status}`,
  );
  const metadata = await response.json();
  assert.equal(metadata.name, name, "Registry returned an unexpected package");
  assert.equal(metadata.version, version, "Registry returned an unexpected version");
  assert.equal(
    metadata.dist?.integrity,
    integrity,
    `${name}@${version} already exists with different archive bytes; use a new version before publishing`,
  );
  return true;
}
