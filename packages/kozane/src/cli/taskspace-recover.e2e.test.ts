import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createClient } from "@libsql/client";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../db/client.js";
import { journalTaskspaceFileChange } from "../lib/server/taskspace-service/file-operation.js";
import { readTaskspaceFile, writeTaskspaceFile } from "../lib/server/taskspace-files.js";

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

it("directs CLI callers to recovery when failed creation cannot compensate shared state", async () => {
  const root = mkdtempSync(join(tmpdir(), "kozane-cli-claim-compensation-"));
  roots.push(root);
  expect(run(root, "init").status).toBe(0);
  writeFileSync(join(root, "blocked"), "Keep this file");
  const client = createClient({ url: `file:${join(root, ".kozane", "kozane.db")}` });
  try {
    await client.execute(
      "CREATE TRIGGER reject_compensation BEFORE DELETE ON taskspace BEGIN SELECT RAISE(ABORT,'compensation refused'); END",
    );
    const creation = run(root, "taskspace", "create", "Blocked", "--no-scope", "--dir", "blocked");
    expect(creation.status).toBe(1);
    expect(creation.stderr).toContain("needs recovery");
    expect((await client.execute("SELECT name FROM taskspace")).rows).toEqual([
      { name: "Blocked" },
    ]);
    expect((await client.execute("SELECT * FROM taskspace_local")).rows).toEqual([]);
    expect((await client.execute("SELECT state,error FROM local_file_operation")).rows).toEqual([
      { state: "pending", error: null },
    ]);
    expect(readFileSync(join(root, "blocked"), "utf8")).toBe("Keep this file");
  } finally {
    client.close();
  }
}, 30000);

it("inspects and explicitly confirms a real interrupted CLI creation without retrying it", async () => {
  const root = mkdtempSync(join(tmpdir(), "kozane-cli-recover-"));
  roots.push(root);
  expect(run(root, "init").status).toBe(0);
  const client = createClient({ url: `file:${join(root, ".kozane", "kozane.db")}` });
  try {
    await client.execute(
      "CREATE TRIGGER interrupt_claim AFTER UPDATE ON local_file_operation WHEN NEW.state='confirmed' AND OLD.state='pending' BEGIN UPDATE local_file_operation SET created_at=created_at+1 WHERE id=NEW.id; END",
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
      "CREATE TRIGGER interrupt_layout AFTER UPDATE ON local_file_operation WHEN NEW.state='confirmed' AND OLD.state='pending' AND NEW.kind='taskspace.directory' BEGIN UPDATE taskspace_local SET path='different'; END",
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
    await client.execute(
      "CREATE TRIGGER change_layout_receipt AFTER UPDATE ON local_file_operation WHEN NEW.state='confirmed' AND NEW.kind='taskspace.directory' BEGIN UPDATE taskspace_local SET path='different'; END",
    );
    const refused = run(root, "taskspace", "recover", String(pending.id), "--apply");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("attachment changed");
    expect((await client.execute("SELECT * FROM taskspace")).rows).toEqual(shared);
    expect((await client.execute("SELECT * FROM taskspace_local")).rows).toEqual(attachment);
    expect(
      (
        await client.execute(
          "SELECT state FROM local_file_operation WHERE kind='taskspace.directory'",
        )
      ).rows[0].state,
    ).toBe("pending");
    expect(readFileSync(markerPath)).toEqual(marker);
    await client.execute("DROP TRIGGER change_layout_receipt");
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

it("previews and confirms a real interrupted file save through the CLI without rewriting its bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "kozane-cli-file-recover-"));
  roots.push(root);
  expect(run(root, "init").status).toBe(0);
  expect(run(root, "taskspace", "create", "Notes", "--no-scope").status).toBe(0);
  const url = `file:${join(root, ".kozane", "kozane.db")}`;
  const client = createClient({ url });
  try {
    const taskspace = (await client.execute("SELECT * FROM taskspace")).rows[0];
    const baseDir = join(
      root,
      String((await client.execute("SELECT path FROM taskspace_local")).rows[0].path),
    );
    writeFileSync(join(baseDir, "note.txt"), "Original");
    const content = "Saved 日本語 🪁\n";
    const signature = readTaskspaceFile({ baseDir, subPath: "note.txt" }).signature;
    await client.execute(
      "CREATE TRIGGER interrupt_save BEFORE UPDATE ON local_file_operation BEGIN SELECT RAISE(ABORT,'interrupted'); END",
    );
    const connection = await openDb(url);
    try {
      await expect(
        journalTaskspaceFileChange(
          {
            db: connection.db,
            namespaceId: String(taskspace.namespace_id),
            taskspaceId: String(taskspace.id),
            root,
            baseDir,
            request: { operation: "save-file", subPath: "note.txt", content, signature },
            currentBaseDir: async () => baseDir,
          },
          () => writeTaskspaceFile({ baseDir, subPath: "note.txt", content, signature }),
        ),
      ).rejects.toMatchObject({ phase: "confirm" });
    } finally {
      connection.close();
    }
    await client.execute("DROP TRIGGER interrupt_save");
    const pending = (
      await client.execute("SELECT * FROM local_file_operation WHERE kind='taskspace.file'")
    ).rows[0];
    await client.execute(
      "UPDATE taskspace SET created_at=9007199254740993,updated_at=-9007199254740995",
    );
    await client.execute("UPDATE taskspace_local SET last_seen_at=9007199254740997");
    const sharedQuery =
      "SELECT id,namespace_id,scope_id,name,CAST(created_at AS TEXT) AS created_at,CAST(updated_at AS TEXT) AS updated_at FROM taskspace";
    const attachmentQuery =
      "SELECT taskspace_id,path,path_kind,CAST(last_seen_at AS TEXT) AS last_seen_at FROM taskspace_local";
    const shared = (await client.execute(sharedQuery)).rows;
    const attachment = (await client.execute(attachmentQuery)).rows;
    const preview = run(root, "taskspace", "recover", String(pending.id));
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("action    : save-file");
    expect(preview.stdout).toContain(JSON.parse(String(pending.intent)).contentHash);
    expect(preview.stdout).toContain("Review disk state");
    expect(
      (await client.execute("SELECT * FROM local_file_operation WHERE kind='taskspace.file'")).rows,
    ).toEqual([pending]);
    writeFileSync(join(baseDir, "note.txt"), "Newer edit");
    const blocked = run(root, "taskspace", "recover", String(pending.id), "--apply");
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("different-content");
    expect(readFileSync(join(baseDir, "note.txt"), "utf8")).toBe("Newer edit");
    writeFileSync(join(baseDir, "note.txt"), content);
    const applied = run(root, "taskspace", "recover", String(pending.id), "--apply");
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("File operation tracking confirmed. No files changed.");
    expect(readFileSync(join(baseDir, "note.txt"), "utf8")).toBe(content);
    expect((await client.execute(sharedQuery)).rows).toEqual(shared);
    expect((await client.execute(attachmentQuery)).rows).toEqual(attachment);
    expect(
      (await client.execute("SELECT state FROM local_file_operation WHERE kind='taskspace.file'"))
        .rows[0].state,
    ).toBe("confirmed");
    const repeated = run(root, "taskspace", "recover", String(pending.id), "--apply");
    expect(repeated.status).toBe(0);
    expect(repeated.stdout).toContain("already confirmed");
  } finally {
    client.close();
  }
}, 60000);
