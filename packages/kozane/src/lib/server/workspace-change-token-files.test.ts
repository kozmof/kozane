import { afterEach, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDB } from "../../test-utils/db.js";
import { nodeCommitRevision } from "../../db/tx.js";
import { UnavailableError } from "../../services/errors.js";
import { workspaceChangeToken } from "./workspace-change-token.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kozane-change-token-"));
  roots.push(root);
  const path = join(root, "workspace.db");
  const header = Buffer.alloc(20);
  header[18] = header[19] = 2;
  writeFileSync(path, header);
  const db = await createTestDB();
  return { db, path, header, token: () => workspaceChangeToken(db, `file:${path}`) };
}
it("distinguishes absent sidecars from WAL-index changes without relying on sidecar timestamps", async () => {
  const f = await fixture();
  expect(f.token()).toBe(f.token());
  writeFileSync(f.path + "-wal", "wal");
  writeFileSync(f.path + "-shm", Buffer.alloc(48));
  const before = f.token();
  expect(f.token()).toBe(before);
  const header = Buffer.alloc(48);
  header[8] = 1;
  // Only SHM bytes change. Main/WAL identities, timestamps and sizes stay untouched.
  writeFileSync(f.path + "-shm", header);
  expect(f.token()).not.toBe(before);
  expect(f.token()).toBe(f.token());
});
it.each(["rollback", "wal-without-shm"])("refreshes conservatively for %s", async (mode) => {
  const f = await fixture();
  if (mode === "rollback") {
    f.header[18] = f.header[19] = 1;
    writeFileSync(f.path, f.header);
  } else writeFileSync(f.path + "-wal", "wal");
  expect(f.token()).not.toBe(f.token());
});
it.each(["main", "shm"])("rejects a truncated %s header", async (part) => {
  const f = await fixture();
  writeFileSync(part === "main" ? f.path : f.path + "-shm", Buffer.alloc(3));
  expect(f.token).toThrow(UnavailableError);
});
it.each(["main-stat", "wal-stat", "main-read", "shm-read"])(
  "rejects failed %s metadata instead of treating it as absent",
  async (part) => {
    const f = await fixture();
    const path = f.path + (part.startsWith("wal") ? "-wal" : part.startsWith("shm") ? "-shm" : "");
    rmSync(path, { force: true });
    if (part.endsWith("stat")) symlinkSync(path, path);
    else mkdirSync(path);
    expect(f.token).toThrow("Unable to check workspace changes");
    expect(f.token).toThrow(UnavailableError);
  },
);
it("detects external commits across WAL rewrites and checkpoints without a tracked Node write", async () => {
  const f = await fixture();
  rmSync(f.path);
  // Isolate the native WAL holder from the application's libsql driver so this
  // fixture exercises native shared-memory sidecars.
  const script = String.raw`
    const {DatabaseSync}=require('node:sqlite');
    const {spawnSync}=require('node:child_process');
    const {statSync}=require('node:fs');
    const path=process.argv[1];
    const db=new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(v TEXT); INSERT INTO t VALUES('a'); PRAGMA wal_checkpoint(TRUNCATE)");
    process.on('message', (value) => {
      if (value === 'checkpoint') db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      else {
        const writer=spawnSync(process.execPath,['-e',"const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.prepare('UPDATE t SET v=?').run(process.argv[2]); db.close();",path,value],{encoding:'utf8',timeout:5000});
        if(writer.status!==0) throw new Error(writer.stderr);
      }
      process.send({size:statSync(path+'-wal').size, value:db.prepare('SELECT v FROM t').get().v});
    });
    process.on('disconnect', () => db.close());
    process.send({ready:true});
  `;
  const child = spawn(process.execPath, ["-e", script, f.path], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += chunk;
  });
  function response() {
    return new Promise<{ ready?: boolean; size?: number; value?: string }>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", message);
        child.off("exit", exit);
        child.off("error", error);
      };
      const error = (cause: Error) => {
        cleanup();
        reject(cause);
      };
      const exit = () => error(new Error(`SQLite fixture exited: ${stderr}`));
      const message = (value: object) => {
        cleanup();
        resolve(value);
      };
      const timer = setTimeout(() => error(new Error(`SQLite fixture timed out: ${stderr}`)), 6000);
      child.once("message", message);
      child.once("exit", exit);
      child.once("error", error);
    });
  }
  try {
    const ready = await response();
    expect(ready).toEqual({ ready: true });
    const revision = nodeCommitRevision(f.db);
    let previous = f.token();
    let walSize: number | undefined;
    for (const value of ["b", "c", "d"]) {
      const reply = response();
      child.send(value);
      const written = await reply;
      expect(written.value).toBe(value);
      const committed = f.token();
      expect(committed).not.toBe(previous);
      expect(f.token()).toBe(committed);
      if (walSize !== undefined) expect(written.size).toBe(walSize);
      walSize = written.size;
      const checkpoint = response();
      child.send("checkpoint");
      await checkpoint;
      previous = f.token();
      expect(previous).not.toBe(committed);
      expect(f.token()).toBe(previous);
      expect(nodeCommitRevision(f.db)).toEqual(revision);
    }
  } finally {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});
