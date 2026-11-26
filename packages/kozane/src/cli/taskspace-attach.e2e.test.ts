import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createClient } from "@libsql/client";
import { afterEach, expect, it } from "vitest";
import { taskspaceMarkerText } from "../lib/taskspace-marker.js";

const cliEntry = resolve("packages/kozane/src/cli/index.ts");
const loader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const roots: string[] = [];
const taskspaceId = "12345678-1234-4234-8234-123456789abc";
function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", loader, cliEntry, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 30000,
  });
}
async function workspace() {
  const root = mkdtempSync(join(tmpdir(), "kozane-cli-attach-"));
  roots.push(root);
  expect(run(root, "init").status).toBe(0);
  const client = createClient({ url: `file:${join(root, ".kozane", "kozane.db")}` });
  const namespaceId = String((await client.execute("SELECT id FROM namespace LIMIT 1")).rows[0].id);
  await client.execute({
    sql: "INSERT INTO taskspace(id,namespace_id,name,created_at,updated_at) VALUES(?,?,?,123,456)",
    args: [taskspaceId, namespaceId, "Shared taskspace"],
  });
  return { root, client, namespaceId };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("attaches an unmarked user directory to a shared short ID without changing shared data", async () => {
  const { root, client, namespaceId } = await workspace();
  try {
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "user.txt"), "Keep this");
    const shared = (await client.execute("SELECT * FROM taskspace")).rows;
    const attached = run(
      root,
      "taskspace",
      "attach",
      "1234567",
      "--dir",
      "notes",
      "--namespace",
      namespaceId,
    );
    expect(attached.status, attached.stderr).toBe(0);
    expect(attached.stdout).toContain("Attached 1234567 to notes (workspace_relative)");
    expect((await client.execute("SELECT * FROM taskspace")).rows).toEqual(shared);
    expect(
      (await client.execute("SELECT taskspace_id,path,path_kind FROM taskspace_local")).rows,
    ).toEqual([{ taskspace_id: taskspaceId, path: "notes", path_kind: "workspace_relative" }]);
    expect((await client.execute("SELECT kind,state FROM local_file_operation")).rows).toEqual([
      { kind: "taskspace.claim", state: "confirmed" },
    ]);
    expect(readFileSync(join(root, "notes", ".taskspace.json"), "utf8")).toBe(
      taskspaceMarkerText(taskspaceId, namespaceId, false),
    );
    expect(readFileSync(join(root, "notes", "user.txt"), "utf8")).toBe("Keep this");
    const repeated = run(root, "taskspace", "attach", taskspaceId, "--dir", "different");
    expect(repeated.status).toBe(1);
    expect(repeated.stderr).toContain("already has a directory attachment");
    expect((await client.execute("SELECT * FROM local_file_operation")).rows).toHaveLength(1);
  } finally {
    client.close();
  }
}, 30000);

it("recovers interrupted attachment of a new external directory without recreating it", async () => {
  const { root, client } = await workspace();
  const external = mkdtempSync(join(tmpdir(), "kozane-cli-attach-external-"));
  roots.push(external);
  const target = join(external, "notes");
  try {
    const shared = (await client.execute("SELECT * FROM taskspace")).rows;
    await client.execute(
      "CREATE TRIGGER interrupt_claim BEFORE UPDATE ON local_file_operation BEGIN SELECT RAISE(ABORT,'interrupted'); END",
    );
    const attached = run(root, "taskspace", "attach", taskspaceId, "--dir", target);
    expect(attached.status).toBe(1);
    expect(attached.stderr).toContain("needs recovery");
    const operation = (await client.execute("SELECT * FROM local_file_operation")).rows[0];
    expect(operation).toMatchObject({ state: "pending", path: target, path_kind: "absolute" });
    expect(attached.stderr).toContain(String(operation.id));
    expect((await client.execute("SELECT * FROM taskspace_local")).rows).toEqual([]);
    const marker = readFileSync(join(target, ".taskspace.json"));
    await client.execute("DROP TRIGGER interrupt_claim");
    const preview = run(root, "taskspace", "recover", String(operation.id));
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain("Rerun with --apply");
    expect((await client.execute("SELECT state FROM local_file_operation")).rows[0].state).toBe(
      "pending",
    );
    const applied = run(root, "taskspace", "recover", String(operation.id), "--apply");
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toContain("attachment confirmed");
    expect((await client.execute("SELECT path,path_kind FROM taskspace_local")).rows).toEqual([
      { path: target, path_kind: "absolute" },
    ]);
    expect((await client.execute("SELECT * FROM taskspace")).rows).toEqual(shared);
    expect(readFileSync(join(target, ".taskspace.json"))).toEqual(marker);
    expect(JSON.parse(marker.toString("utf8"))).not.toHaveProperty("ownsDirectory");
  } finally {
    client.close();
  }
}, 30000);

it("requires an explicit directory and a matching namespaced identity before recording intent", async () => {
  const { root, client } = await workspace();
  try {
    const missing = run(root, "taskspace", "attach", taskspaceId);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("required option '--dir <path>'");
    const mismatch = run(
      root,
      "taskspace",
      "attach",
      taskspaceId,
      "--dir",
      "notes",
      "--namespace",
      "missing",
    );
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain("Namespace");
    await client.execute("UPDATE taskspace SET namespace_id=NULL");
    const unplaced = run(root, "taskspace", "attach", taskspaceId, "--dir", "notes");
    expect(unplaced.status).toBe(1);
    expect(unplaced.stderr).toContain("must belong to a namespace");
    expect((await client.execute("SELECT * FROM local_file_operation")).rows).toEqual([]);
    expect((await client.execute("SELECT * FROM taskspace_local")).rows).toEqual([]);
  } finally {
    client.close();
  }
}, 30000);
