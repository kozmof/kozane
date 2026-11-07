import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRegistryPackage } from "./check-registry-release.mjs";

const candidate = {
  name: "@kozane/client",
  version: "0.1.0",
  repository: { url: "git+https://github.com/kozmof/kozane.git", directory: "packages/client" },
  dependencies: { dependency: "workspace:0.1.0" },
  peerDependencies: { "@kozane/core": "0.1.0" },
};
const published = {
  ...candidate,
  dependencies: { dependency: "0.1.0" },
  dist: {
    integrity: "sha512-candidate",
    attestations: {
      url: "https://registry.npmjs.org/-/npm/v1/attestations/@kozane%2fclient@0.1.0",
      provenance: { predicateType: "https://slsa.dev/provenance/v1" },
    },
  },
};
test("accepts matching packed versions, peers and registry provenance metadata", () => {
  assert.equal(validateRegistryPackage(candidate, published), published.dist.attestations.url);
});
for (const [name, mutate] of [
  [
    "wrong version",
    (value) => {
      value.version = "0.0.1";
    },
  ],
  [
    "wrong package",
    (value) => {
      value.name = "another-package";
    },
  ],
  [
    "wrong repository",
    (value) => {
      value.repository.url = "git+https://example.com/other.git";
    },
  ],
  [
    "missing provenance",
    (value) => {
      delete value.dist.attestations;
    },
  ],
  [
    "wrong provenance predicate",
    (value) => {
      value.dist.attestations.provenance.predicateType = "other";
    },
  ],
  [
    "external attestation link",
    (value) => {
      value.dist.attestations.url = "https://example.com/attestations";
    },
  ],
  [
    "missing integrity",
    (value) => {
      delete value.dist.integrity;
    },
  ],
  [
    "stale peer",
    (value) => {
      value.peerDependencies["@kozane/core"] = "0.0.1";
    },
  ],
  [
    "loose runtime version",
    (value) => {
      value.dependencies.dependency = "^0.1.0";
    },
  ],
  [
    "extra runtime dependency",
    (value) => {
      value.dependencies.extra = "1.0.0";
    },
  ],
]) {
  test(`rejects ${name}`, () => {
    const value = structuredClone(published);
    mutate(value);
    assert.throws(() => validateRegistryPackage(candidate, value, { requireProvenance: true }));
  });
}

test("accepts local publications without CI provenance", () => {
  const value = structuredClone(published);
  delete value.dist.attestations;
  assert.equal(validateRegistryPackage(candidate, value), null);
});
