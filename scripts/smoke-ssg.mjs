import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const loader = createRequire(join(repository, "package.json")).resolve("tsx");
const workspace = mkdtempSync(join(tmpdir(), "kozane-ssg-smoke-"));
function cli(...args) {
  const result = spawnSync(
    process.execPath,
    ["--import", loader, join(repository, "packages/kozane/src/cli/index.ts"), ...args],
    {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180000,
      env: {
        ...process.env,
        KOZANE_WORKSPACE_ROOT: workspace,
        DATABASE_URL: undefined,
        KOZANE_RUNTIME_DATABASE_URL: undefined,
        KOZANE_MEMORY_MODE: undefined,
        KOZANE_READONLY: undefined,
        KOZANE_SSG: undefined,
        GOMAXPROCS: "2",
        RAYON_NUM_THREADS: "1",
        TOKIO_WORKER_THREADS: "1",
      },
    },
  );
  assert.equal(
    result.status,
    0,
    `kozane ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}\n${result.error ?? ""}`,
  );
  return result.stdout;
}
function id(output) {
  const match = output.match(/^\s*id\s*:\s*(\S+)/m);
  assert.ok(match, `CLI output needs an ID: ${output}`);
  return match[1];
}
function publishedText(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? publishedText(path)
        : /\.(html|json)$/.test(entry.name)
          ? [readFileSync(path, "utf8")]
          : [];
    })
    .join("\n");
}
try {
  cli("init");
  const card = id(cli("card", "add", "SSG compatibility card :exportcheck"));
  const scope = id(cli("scope", "add", "Export scope"));
  cli("scope", "add-cards", scope, card);
  cli("taskspace", "create", "Published notes", "--scope", scope, "--dir", "published");
  cli("taskspace", "create", "Unlinked private taskspace", "--no-scope", "--dir", "private");
  writeFileSync(join(workspace, "published", "notes.md"), "SCOPED_EXPORT_SENTINEL :exportfile\n");
  writeFileSync(join(workspace, "private", "private.md"), "UNLINKED_PRIVATE_SENTINEL\n");
  const dump = JSON.parse(cli("db", "export"));
  const namespaceId = dump.tables.namespace[0].id;
  for (const includeFiles of [false, true]) {
    const output = join(workspace, includeFiles ? "site-files" : "site-default");
    cli(
      "net",
      "ssg",
      "generate",
      "--base",
      "/preview",
      "--out",
      output,
      ...(includeFiles ? ["--include-scoped-files"] : []),
    );
    for (const route of ["", "tags", "map", namespaceId]) {
      const html = readFileSync(join(output, route, "index.html"), "utf8");
      assert.match(html, /Content-Security-Policy/i);
      const dom = new JSDOM(html, {
        url: `https://example.test/preview/${route ? route + "/" : ""}`,
      });
      try {
        const assets = [
          ...dom.window.document.querySelectorAll(
            'link[rel="modulepreload"], link[rel="stylesheet"]',
          ),
        ];
        assert.ok(assets.length > 0, "Missing static assets");
        for (const asset of assets) {
          const path = new URL(asset.href).pathname;
          assert.ok(path.startsWith("/preview/_app/"), `Asset escaped the base path: ${path}`);
          assert.ok(
            existsSync(join(output, path.slice("/preview/".length))),
            `Missing asset: ${path}`,
          );
        }
        assert.ok(dom.window.document.body.textContent.includes("Read-only workspace."));
        assert.equal(dom.window.document.querySelector('[aria-label="Create namespace"]'), null);
      } finally {
        dom.window.close();
      }
      assert.ok(html.includes("staticClientData"), `Missing static client seed on ${route || "/"}`);
    }
    const root = readFileSync(join(output, "index.html"), "utf8");
    const rootDom = new JSDOM(root, { url: "https://example.test/preview/" });
    try {
      assert.ok(
        [...rootDom.window.document.querySelectorAll("a")].some(
          (link) => new URL(link.href).pathname.replace(/\/$/, "") === `/preview/${namespaceId}`,
        ),
        "Namespace links must retain static URLs",
      );
    } finally {
      rootDom.window.close();
    }
    const board = readFileSync(join(output, namespaceId, "index.html"), "utf8");
    assert.ok(board.includes("SSG compatibility card"));
    const text = publishedText(output);
    assert.ok(!text.includes(workspace), "Export leaked its workspace path");
    assert.ok(!text.includes("UNLINKED_PRIVATE_SENTINEL"), "Export leaked unlinked file content");
    assert.ok(
      !text.includes("Unlinked private taskspace"),
      "Export leaked unlinked taskspace metadata",
    );
    assert.equal(
      text.includes("SCOPED_EXPORT_SENTINEL"),
      includeFiles,
      "Scoped-file opt-in mismatch",
    );
    assert.equal(readFileSync(join(output, ".nojekyll"), "utf8"), "");
    console.log(
      `Static export passed at /preview (scoped files ${includeFiles ? "included" : "excluded"}).`,
    );
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
