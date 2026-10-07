import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Compare HTTP specification entries with route exports in both directions. Detect
 * undocumented endpoints and obsolete sections. Read source text instead of importing routes
 * that require SvelteKit and database state.
 */

const ROUTES_DIR = resolve("src/routes");
const SPEC_PATH = resolve("spec/http.md");

/**
 * Temporary documentation exemptions keyed as `METHOD /path`. Keep the list empty when all
 * endpoints are documented and reject entries whose documentation now exists.
 */
const UNSPECIFIED: readonly string[] = [];

/** The methods SvelteKit will route to, so an unrelated `export const` is not read as one. */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;

/**
 * Convert a server route filename to a specification URL. Preserve parameter brackets and
 * omit route-group directories.
 */
function routePath(dir: string): string {
  const segments = relative(ROUTES_DIR, dir)
    .split(sep)
    .filter((segment) => segment !== "" && !segment.startsWith("("));
  return `/${segments.join("/")}`;
}

/** Every `METHOD /path` the route tree answers, sorted. */
function implementedEndpoints(dir = ROUTES_DIR): string[] {
  const endpoints: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      endpoints.push(...implementedEndpoints(path));
      continue;
    }
    if (entry.name !== "+server.ts") continue;
    const source = readFileSync(path, "utf-8");
    for (const method of METHODS) {
      // Anchored to the start of a line, so the name in an import or a comment is not a
      // handler. SvelteKit only routes to a top-level export, which is the same rule.
      if (new RegExp(String.raw`^export const ${method}\b`, "mu").test(source)) {
        endpoints.push(`${method} ${routePath(dir)}`);
      }
    }
  }
  return endpoints.sort();
}

/** The `### \`METHOD /path\`` headings, as written. */
function specifiedEndpoints(): string[] {
  const spec = readFileSync(SPEC_PATH, "utf-8");
  return [...spec.matchAll(/^### `([A-Z]+) (\/[^`]*)`$/gmu)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
}

describe("spec/http.md against the route tree", () => {
  const implemented = implementedEndpoints();
  const specified = specifiedEndpoints();

  // Require the route walk to find entries so an empty result cannot pass every comparison.
  it("finds the route tree", () => {
    expect(implemented.length).toBeGreaterThan(20);
    expect(implemented).toContain("GET /health");
  });

  it("documents no endpoint that does not exist", () => {
    const real = new Set(implemented);
    expect(specified.filter((endpoint) => !real.has(endpoint))).toEqual([]);
  });

  it("documents every endpoint except the ones recorded as unspecified", () => {
    const documented = new Set(specified);
    const missing = implemented.filter(
      (endpoint) => !documented.has(endpoint) && !UNSPECIFIED.includes(endpoint),
    );

    expect(missing).toEqual([]);
  });

  it("documents each endpoint once", () => {
    const duplicated = specified.filter((endpoint, index) => specified.indexOf(endpoint) !== index);

    // Reject duplicate specification sections for the same endpoint.
    expect(duplicated).toEqual([]);
  });

  it("keeps the unspecified list honest", () => {
    const documented = new Set(specified);
    const real = new Set(implemented);

    // An entry that has since been written up, and should have been deleted from the list
    // rather than left to exempt a section that now exists.
    expect(UNSPECIFIED.filter((endpoint) => documented.has(endpoint))).toEqual([]);
    // An entry naming an endpoint that no longer exists.
    expect(UNSPECIFIED.filter((endpoint) => !real.has(endpoint))).toEqual([]);
  });
});
