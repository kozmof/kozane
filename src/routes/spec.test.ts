import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `spec/http.md` against the endpoints it specifies.
 *
 * The CLI has had this since `spec/cli.md` was written: a check that runs both ways, so a
 * command renamed or removed fails rather than leaving the spec describing something that
 * is no longer there. The HTTP surface had nothing of the kind — twenty-two route files
 * reached by every browser on the workspace, and a route deleted, moved, or given another
 * method was caught only by whichever unit test happened to cover it.
 *
 * Spec → code catches a section describing an endpoint that is gone. Code → spec catches an
 * endpoint shipped without one, which is what the whole surface had been.
 *
 * The router is the filesystem, so the filesystem is what is walked. Read as text rather
 * than imported: a route module pulls in `./$types`, `$app/*` and a database, none of which
 * exist to answer the only question here — which methods this file exports.
 */

const ROUTES_DIR = resolve("src/routes");
const SPEC_PATH = resolve("spec/http.md");

/**
 * Endpoints `spec/http.md` does not document.
 *
 * Empty, and the check below is what keeps it that way: an endpoint added without a section
 * fails rather than quietly joining a list of exemptions. Kept as a list rather than deleted
 * outright so that an endpoint shipped ahead of its documentation has somewhere honest to be
 * recorded, instead of the check being loosened. An entry here is a debt; an entry that has
 * since been documented is a failure, which is what the last test is for.
 *
 * Written as `METHOD /path`, the same key the check uses.
 */
const UNSPECIFIED: readonly string[] = [];

/** The methods SvelteKit will route to, so an unrelated `export const` is not read as one. */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;

/**
 * The URL a `+server.ts` answers on, as the spec spells it.
 *
 * Route parameters keep their brackets — `/[namespaceId]/api/cards/[cardId]` — because that
 * is both how SvelteKit names them and how the URL reads as a template. Group directories
 * (`(name)`) do not appear in a URL and are dropped; there are none today, and this is what
 * keeps the check right when there are.
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

  // A guard on the walk itself: a change to the layout that made it find nothing would
  // otherwise pass every check below by having nothing to compare.
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

    // Two sections for one endpoint means one of them is unread, and neither is under the
    // check above — both match something real.
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
