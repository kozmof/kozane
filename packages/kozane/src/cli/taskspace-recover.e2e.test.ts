import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createClient } from "@libsql/client";
import { afterEach, expect, it } from "vitest";

const cliEntry = resolve("packages/kozane/src/cli/index.ts");
const loader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const roots: string[] = [];
function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", loader, cliEntry, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 30000,
  });
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("inspects and explicitly confirms a real interrupted CLI creation without retrying it", async () => {
  const root = mkdtempSync(join(tmpdir(), "kozane-cli-recover-"));
  roots.push(root);
  expect(run(root, "init").status).toBe(0);
  const client = createClient({ url: `file:${join(root, ".kozane", "kozane.db")}` });
  try {
    await client.execute(
      "CREATE TRIGGER interrupt_claim BEFORE UPDATE ON local_file_operation BEGIN SELECT RAISE(ABORT,'interrupted'); END",
    );
    const creation = run(root, "taskspace", "create", "Interrupted", "--no-scope");
    expect(creation.status).toBe(1);
    expect(creation.stderr).toContain("needs recovery");
    await client.execute("DROP TRIGGER interrupt_claim");
    const operation = (await client.execute("SELECT * FROM local_file_operation")).rows[0];
    const id = String(operation.id);
    const markerPath = join(root, String(operation.path), ".taskspace.json");
    const bytes = readFileSync(markerPath);
    const preview = run(root, "taskspace", "recover", id);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("Rerun with --apply");
    expect((await client.execute("SELECT state FROM local_file_operation")).rows[0].state).toBe(
      "pending",
    );
    expect((await client.execute("SELECT * FROM taskspace_local")).rows).toHaveLength(0);
    const applied = run(root, "taskspace", "recover", id, "--apply");
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("attachment confirmed");
    expect((await client.execute("SELECT state FROM local_file_operation")).rows[0].state).toBe(
      "confirmed",
    );
    expect((await client.execute("SELECT path FROM taskspace_local")).rows[0].path).toBe(
      operation.path,
    );
    expect(readFileSync(markerPath)).toEqual(bytes);
    const repeated = run(root, "taskspace", "recover", id, "--apply");
    expect(repeated.status).toBe(0);
    expect(repeated.stdout).toContain("already confirmed");
    const missing = run(root, "taskspace", "recover", "missing", "--apply");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("not found");
  } finally {
    client.close();
  }
}, 30000);

it("recovers an interrupted doctor layout commit and then finishes configuration without moving files again", async () => {
  const root = mkdtempSync(join(tmpdir(), "kozane-cli-layout-recover-"));
  roots.push(root);
  expect(run(root, "init").status).toBe(0);
  const configPath = join(root, ".kozane", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.server.port = 0;
  config.taskspace.defaultDir = ".";
  config.taskspace.namespaceDirs = false;
  writeFileSync(configPath, JSON.stringify(config));
  expect(run(root, "taskspace", "create", "notes", "--no-scope").status).toBe(0);
  writeFileSync(join(root, "notes", "a.txt"), "Retained content");
  delete config.taskspace.namespaceDirs;
  writeFileSync(configPath, JSON.stringify(config));
  const client = createClient({ url: `file:${join(root, ".kozane", "kozane.db")}` });
  try {
    const shared = (await client.execute("SELECT * FROM taskspace")).rows;
    const attachment = (await client.execute("SELECT * FROM taskspace_local")).rows;
    await client.execute(
      "CREATE TRIGGER interrupt_layout BEFORE UPDATE ON local_file_operation BEGIN SELECT RAISE(ABORT,'interrupted'); END",
    );
    const failed = run(root, "doctor", "--fix");
    expect(failed.stdout).toContain("needs recovery");
    await client.execute("DROP TRIGGER interrupt_layout");
    const pending = (
      await client.execute("SELECT * FROM local_file_operation WHERE kind='taskspace.directory'")
    ).rows[0];
    expect(pending.state).toBe("pending");
    const intent = JSON.parse(String(pending.intent));
    const markerPath = join(root, intent.targetPath, ".taskspace.json");
    const marker = readFileSync(markerPath);
    const preview = run(root, "taskspace", "recover", String(pending.id));
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("action    : layout");
    expect(preview.stdout).toContain("Rerun with --apply");
    expect((await client.execute("SELECT * FROM taskspace_local")).rows).toEqual(attachment);
    expect(
      (
        await client.execute(
          "SELECT state FROM local_file_operation WHERE kind='taskspace.directory'",
        )
      ).rows[0].state,
    ).toBe("pending");
    const applied = run(root, "taskspace", "recover", String(pending.id), "--apply");
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("database changes confirmed. No files changed.");
    expect((await client.execute("SELECT * FROM taskspace")).rows).toEqual(shared);
    expect((await client.execute("SELECT * FROM taskspace_local")).rows).toEqual([
      { ...attachment[0], path: intent.targetPath },
    ]);
    expect(readFileSync(markerPath)).toEqual(marker);
    expect(readFileSync(join(root, intent.targetPath, "a.txt"), "utf8")).toBe("Retained content");
    const operations = (await client.execute("SELECT * FROM local_file_operation")).rows;
    const fixed = run(root, "doctor", "--fix");
    expect(fixed.status).toBe(0);
    expect(JSON.parse(readFileSync(configPath, "utf8")).taskspace.defaultDir).toBe("taskspaces");
    expect((await client.execute("SELECT * FROM local_file_operation")).rows).toEqual(operations);
    expect(readFileSync(markerPath)).toEqual(marker);
  } finally {
    client.close();
  }
}, 60000);
