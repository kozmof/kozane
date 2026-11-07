import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function validateRegistryPackage(candidate, published, { requireProvenance = false } = {}) {
  assert.equal(published.name, candidate.name);
  assert.equal(published.version, candidate.version);
  assert.equal(published.repository.url, candidate.repository.url);
  assert.equal(published.repository.directory, candidate.repository.directory);
  assert.match(published.dist.integrity, /^sha512-/);
  assert.deepEqual(
    published.dependencies ?? {},
    Object.fromEntries(
      Object.entries(candidate.dependencies ?? {}).map(([name, version]) => [
        name,
        version.replace(/^workspace:/, ""),
      ]),
    ),
  );
  assert.deepEqual(published.peerDependencies ?? {}, candidate.peerDependencies ?? {});
  if (!published.dist.attestations) {
    assert.equal(requireProvenance, false, "Registry provenance metadata is required");
    return null;
  }
  assert.equal(
    published.dist.attestations?.provenance?.predicateType,
    "https://slsa.dev/provenance/v1",
  );
  const attestations = new URL(published.dist.attestations.url);
  assert.equal(attestations.origin, "https://registry.npmjs.org");
  return attestations.href;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const directory of ["core", "client", "kozane"]) {
    const candidate = JSON.parse(
      readFileSync(new URL(`../packages/${directory}/package.json`, import.meta.url), "utf8"),
    );
    const target = `${candidate.name}@${candidate.version}`;
    const published = JSON.parse(
      execFileSync("npm", ["view", target, "--json", "--registry=https://registry.npmjs.org/"], {
        encoding: "utf8",
        timeout: 60_000,
      }),
    );
    const attestations = validateRegistryPackage(candidate, published);
    console.log(
      `${target} has the expected registry metadata and provenance metadata: ${attestations ?? "not supplied by local publication"}`,
    );
  }
}
