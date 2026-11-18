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
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "kozane-cli-upload-recovery-"));
  roots.push(root);
  expect(run(root, "init").status).toBe(0);
  const path = join(root, ".kozane", "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.server.port = 0;
  writeFileSync(path, JSON.stringify(config));
  writeFileSync(join(root, "image.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("lists, previews and recovers a real interrupted CLI upload without repeating disk work", async () => {
  const root = workspace();
  const client = createClient({ url: `file:${join(root, ".kozane", "kozane.db")}` });
  try {
    await client.execute(
      "CREATE TRIGGER reject_install BEFORE UPDATE ON local_image_upload WHEN NEW.state='installed' BEGIN SELECT RAISE(ABORT,'interrupted'); END",
    );
    const failed = run(root, "card", "add", "--type", "image", join(root, "image.svg"));
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("needs review");
    await client.execute("DROP TRIGGER reject_install");
    const pending = (await client.execute("SELECT * FROM local_image_upload")).rows[0];
    const filename = String(pending.filename);
    const path = join(root, ".kozane", "assets", "images", filename);
    const bytes = readFileSync(path);
    expect(pending.state).toBe("pending");
    expect(run(root, "image", "uploads").stdout).toContain(filename);
    for (const args of [[], ["--fix"]]) {
      const doctor = run(root, "doctor", ...args);
      expect(doctor.status).toBe(1);
      expect(doctor.stdout).toContain("Image uploads resolved");
      expect(doctor.stdout).toContain(filename);
      expect(doctor.stdout).toContain("--fix does not retry uploads");
    }
    const preview = run(root, "image", "recover", filename);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("Read-only preview");
    expect(preview.stdout).toContain("matching-content");
    expect((await client.execute("SELECT * FROM local_image_upload")).rows).toEqual([pending]);
    const applied = run(root, "image", "recover", filename, "--apply");
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("Its pin remains");
    const installed = (await client.execute("SELECT * FROM local_image_upload")).rows;
    expect(installed[0].state).toBe("installed");
    expect((await client.execute("SELECT * FROM card")).rows).toEqual([]);
    expect(readFileSync(path)).toEqual(bytes);
    expect(run(root, "image", "recover", filename, "--apply").status).toBe(0);
    expect((await client.execute("SELECT * FROM local_image_upload")).rows).toEqual(installed);
    expect(run(root, "card", "add", "kozane-image:/api/images/" + filename).status).toBe(0);
    expect((await client.execute("SELECT state FROM local_image_upload")).rows[0].state).toBe(
      "completed",
    );
    expect(run(root, "image", "uploads").stdout).toContain("No unfinished image uploads");
    expect(run(root, "image", "uploads", "--all").stdout).toContain("completed");
    expect(run(root, "image", "recover", filename, "--apply").stdout).toContain(
      "already completed",
    );
    expect(run(root, "doctor").status).toBe(0);
    expect(readFileSync(path)).toEqual(bytes);
  } finally {
    client.close();
  }
}, 60000);

it("previews explicit abandonment, retains errors and files, and refuses a replacement decision", async () => {
  const root = workspace();
  const failed = run(
    root,
    "card",
    "add",
    "--type",
    "image",
    join(root, "image.svg"),
    "--namespace",
    "missing",
  );
  expect(failed.status).toBe(1);
  const client = createClient({ url: `file:${join(root, ".kozane", "kozane.db")}` });
  try {
    await client.execute(
      "UPDATE local_image_upload SET state='pending',installed_at=NULL,error='Original failure'",
    );
    const pending = (await client.execute("SELECT * FROM local_image_upload")).rows[0];
    const filename = String(pending.filename);
    const path = join(root, ".kozane", "assets", "images", filename);
    const bytes = readFileSync(path);
    const recover = run(root, "image", "recover", filename, "--apply");
    expect(recover.status).toBe(1);
    expect(recover.stderr).toContain("filesystem error was recorded");
    expect(run(root, "image", "abandon", filename, "--apply").status).toBe(1);
    const args = ["image", "abandon", filename, "--reason", "Reviewed failed upload"];
    const preview = run(root, ...args);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("Read-only preview");
    expect((await client.execute("SELECT * FROM local_image_upload")).rows).toEqual([pending]);
    const applied = run(root, ...args, "--apply");
    expect(applied.status).toBe(0);
    expect(applied.stdout).toContain("Upload pin released");
    const decision = (await client.execute("SELECT * FROM local_image_upload")).rows;
    expect(decision[0]).toMatchObject({
      state: "abandoned",
      error: "Original failure",
      abandon_reason: "Reviewed failed upload",
      filename: pending.filename,
      sha256: pending.sha256,
      byte_length: pending.byte_length,
    });
    expect(run(root, ...args, "--apply").stdout).toContain("already abandoned");
    expect(
      run(root, "image", "abandon", filename, "--reason", "Different reason", "--apply").status,
    ).toBe(1);
    expect(run(root, "image", "recover", filename, "--apply").status).toBe(1);
    expect((await client.execute("SELECT * FROM local_image_upload")).rows).toEqual(decision);
    expect(run(root, "image", "uploads").stdout).toContain("No unfinished image uploads");
    expect(run(root, "image", "uploads", "--all").stdout).toContain("abandoned");
    expect(run(root, "doctor", "--fix").status).toBe(0);
    expect(readFileSync(path)).toEqual(bytes);
    expect((await client.execute("SELECT * FROM card")).rows).toEqual([]);
  } finally {
    client.close();
  }
}, 60000);
