import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createClient } from "@libsql/client";
import { afterEach, expect, it } from "vitest";

const entry = resolve("packages/kozane/src/cli/index.ts");
const loader = createRequire(join(process.cwd(), "package.json")).resolve("tsx");
const roots: string[] = [];
function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", loader, entry, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 30000,
  });
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("previews and explicitly abandons tracking while retaining evidence and disk contents", async () => {
  const root = mkdtempSync(join(tmpdir(), "kozane-cli-abandon-"));
  roots.push(root);
  expect(run(root, "init").status).toBe(0);
  writeFileSync(join(root, "notes.txt"), "Keep notes");
  const client = createClient({ url: `file:${join(root, ".kozane", "kozane.db")}` });
  try {
    await client.execute(
      "INSERT INTO local_file_operation(id,kind,version,taskspace_id,namespace_id,path,path_kind,state,intent,created_at,error) VALUES('reviewed','taskspace.file',1,'missing','missing','notes.txt','workspace_relative','pending','{}',1,'Original failure')",
    );
    const missingReason = run(root, "taskspace", "abandon", "reviewed", "--apply");
    expect(missingReason.status).toBe(1);
    expect(missingReason.stderr).toContain("--reason");
    const preview = run(root, "taskspace", "abandon", "reviewed", "--reason", "Reviewed on disk");
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("Read-only preview");
    expect((await client.execute("SELECT state FROM local_file_operation")).rows[0].state).toBe(
      "pending",
    );
    const pending = (await client.execute("SELECT * FROM local_file_operation")).rows;
    await client.execute(
      "CREATE TRIGGER change_abandonment AFTER UPDATE ON local_file_operation WHEN NEW.state='abandoned' AND OLD.state='pending' BEGIN UPDATE local_file_operation SET error='Different failure' WHERE id=NEW.id; END",
    );
    const refused = run(
      root,
      "taskspace",
      "abandon",
      "reviewed",
      "--reason",
      "Reviewed on disk",
      "--apply",
    );
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("abandonment changed");
    expect((await client.execute("SELECT * FROM local_file_operation")).rows).toEqual(pending);
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("Keep notes");
    await client.execute("DROP TRIGGER change_abandonment");
    const applied = run(
      root,
      "taskspace",
      "abandon",
      "reviewed",
      "--reason",
      "Reviewed on disk",
      "--apply",
    );
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("evidence was retained");
    const abandoned = (await client.execute("SELECT * FROM local_file_operation")).rows;
    expect(abandoned[0]).toMatchObject({
      state: "abandoned",
      abandon_reason: "Reviewed on disk",
      error: "Original failure",
      intent: "{}",
      confirmed_at: null,
    });
    expect(Number(abandoned[0].abandoned_at)).toBeGreaterThan(0);
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("Keep notes");
    const repeated = run(
      root,
      "taskspace",
      "abandon",
      "reviewed",
      "--reason",
      "Reviewed on disk",
      "--apply",
    );
    expect(repeated.status).toBe(0);
    expect(repeated.stdout).toContain("already abandoned");
    const changedReason = run(
      root,
      "taskspace",
      "abandon",
      "reviewed",
      "--reason",
      "Another reason",
      "--apply",
    );
    expect(changedReason.status).toBe(1);
    expect(changedReason.stderr).toContain("another reason");
    expect((await client.execute("SELECT * FROM local_file_operation")).rows).toEqual(abandoned);
  } finally {
    client.close();
  }
}, 30000);
