import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { sql } from "drizzle-orm";
import type { DB } from "../../../db/database.js";
import type { DB as CoreDB } from "../../../../../core/src/database.js";
import { createTestDB } from "../../../test-utils/db.js";
import { captureApplicationRows } from "../../../test-utils/action-tables.js";
import { addNamespace } from "../../../db/api/namespace.js";
import { addTaskspace, getAllTaskspaceLocalMetadata } from "../../../db/api/taskspace.js";
import { localFileOperationTable } from "../../../db/schema.js";
import { _resetWorkspaceRootForTest } from "../../../db/internal/config.js";
import { TASKSPACE_MARKER_FILE, taskspaceMarkerText } from "../../taskspace-marker.js";
import { contentHash } from "../local-file-operations.js";
import { readTaskspaceFile } from "../taskspace-files.js";
import { claimRecordedTaskspace } from "./claim.js";
import { saveFile } from "./file.js";
import { renameTaskspace } from "./mutate.js";
import { recoverLocalClaim } from "./recover-claim.js";
import { recoverFileOperation } from "./recover-file.js";
import { recoverDirectoryOperation } from "./recover-directory.js";
import { oneAtATime } from "./queue.js";

type Kind = "claim" | "file" | "directory";
let db: DB;
let root: string;
let namespaceId: string;
let previousRoot: string | undefined;
const path = "tasks/draft";
beforeEach(async () => {
  db = await createTestDB();
  root = mkdtempSync(join(tmpdir(), "kozane-reviewed-recovery-"));
  mkdirSync(join(root, ".kozane"));
  writeFileSync(
    join(root, ".kozane", "config.json"),
    JSON.stringify({ name: "Test", taskspace: { defaultDir: "tasks", namespaceDirs: false } }),
  );
  namespaceId = await addNamespace({ db, name: "Namespace" });
  previousRoot = process.env.KOZANE_WORKSPACE_ROOT;
  process.env.KOZANE_WORKSPACE_ROOT = root;
  _resetWorkspaceRootForTest();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.KOZANE_WORKSPACE_ROOT;
  else process.env.KOZANE_WORKSPACE_ROOT = previousRoot;
  _resetWorkspaceRootForTest();
  rmSync(root, { recursive: true, force: true });
});
const rows = () => db.select().from(localFileOperationTable);

function files(dir = root): [string, string | null][] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry): [string, string | null][] => {
      const target = join(dir, entry.name);
      return entry.isDirectory()
        ? [[relative(root, target), null], ...files(target)]
        : [[relative(root, target), readFileSync(target).toString("hex")]];
    });
}

async function pending(kind: Kind) {
  await db.run(sql`CREATE TRIGGER reject_confirmation BEFORE UPDATE ON local_file_operation
  BEGIN SELECT RAISE(ABORT,'interrupted'); END`);
  if (kind === "claim") {
    await expect(
      claimRecordedTaskspace(
        { db, namespaceId, name: "draft", path, pathKind: "workspace_relative" },
        {
          workspaceRoot: root,
          targetDir: join(root, path),
          adoptExisting: false,
          parentsInside: true,
          ownIfCreated: true,
        },
      ),
    ).rejects.toMatchObject({ phase: "attach" });
  } else {
    const taskspaceId = await addTaskspace({ db, namespaceId, name: "draft", path });
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(
      join(root, path, TASKSPACE_MARKER_FILE),
      taskspaceMarkerText(taskspaceId, namespaceId, true),
    );
    writeFileSync(join(root, path, "original.txt"), "Original");
    await expect(
      kind === "file"
        ? saveFile(
            { db },
            { namespaceId, taskspaceId },
            {
              path: "original.txt",
              content: "Intended content",
              signature: readTaskspaceFile({ baseDir: join(root, path), subPath: "original.txt" })
                .signature,
            },
          )
        : renameTaskspace({ db }, { namespaceId, taskspaceId }, { name: "final" }),
    ).rejects.toMatchObject({ status: 500 });
  }
  await db.run(sql`DROP TRIGGER reject_confirmation`);
  const [operation] = await rows();
  const procedure = {
    claim: recoverLocalClaim,
    file: recoverFileOperation,
    directory: recoverDirectoryOperation,
  }[kind];
  return { operation, recover: (apply = false) => procedure(db, root, operation.id, apply) };
}

async function hold(taskspaceId: string) {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = oneAtATime(taskspaceId, async () => {
    entered();
    await waiting;
  });
  await started;
  return { held, release };
}

describe.each(["claim", "file", "directory"] as const)("%s recovery evidence", (kind) => {
  it.each([
    "kind",
    "taskspace",
    "namespace",
    "path",
    "path-kind",
    "intent",
    "created",
    "error",
  ] as const)(
    "refuses changed %s evidence while queued and preserves current state",
    async (field) => {
      const { operation, recover } = await pending(kind);
      const { held, release } = await hold(operation.taskspaceId);
      const applying = recover(true);
      const finished = applying.catch(() => undefined);
      try {
        expect((await recover()).status).toBe("confirmable");
        if (field === "intent") {
          const intent = JSON.parse(operation.intent);
          if (kind === "claim") intent.parentsInside = !intent.parentsInside;
          if (kind === "file") {
            intent.contentHash = contentHash("Later bytes");
            writeFileSync(join(root, path, "original.txt"), "Later bytes");
          }
          if (kind === "directory") {
            intent.name = "revised";
            intent.targetPath = "tasks/revised";
            renameSync(join(root, "tasks", "final"), join(root, "tasks", "revised"));
          }
          await db.update(localFileOperationTable).set({ intent: JSON.stringify(intent) });
          expect((await recover()).status).toBe("confirmable");
        } else {
          const changes = {
            kind: `kind='${kind === "file" ? "taskspace.claim" : "taskspace.file"}'`,
            taskspace: "taskspace_id='different'",
            namespace: "namespace_id='different'",
            path: "path='different'",
            "path-kind": "path_kind='absolute'",
            created: "created_at=created_at+1",
            error: "error='Later failure'",
          };
          await db.run(sql.raw(`UPDATE local_file_operation SET ${changes[field]}`));
        }
        const journal = await rows();
        const shared = await captureApplicationRows(db as unknown as CoreDB);
        const local = await getAllTaskspaceLocalMetadata({ db });
        const disk = files();
        const rejected = expect(applying).rejects.toThrow("evidence changed");
        release();
        await held;
        await rejected;
        expect(await rows()).toEqual(journal);
        expect(await captureApplicationRows(db as unknown as CoreDB)).toEqual(shared);
        expect(await getAllTaskspaceLocalMetadata({ db })).toEqual(local);
        expect(files()).toEqual(disk);
      } finally {
        release();
        await held;
        await finished;
      }
    },
  );

  it.each(["intent", "created"] as const)(
    "refuses changed %s on an already confirmed receipt while queued",
    async (field) => {
      const { operation, recover } = await pending(kind);
      expect((await recover(true)).status).toBe("confirmed");
      const { held, release } = await hold(operation.taskspaceId);
      const applying = recover(true);
      const finished = applying.catch(() => undefined);
      try {
        expect((await recover()).status).toBe("already-confirmed");
        if (field === "intent")
          await db
            .update(localFileOperationTable)
            .set({ intent: JSON.stringify(JSON.parse(operation.intent), null, 1) });
        else await db.run(sql`UPDATE local_file_operation SET created_at=created_at+1`);
        const journal = await rows();
        const disk = files();
        const rejected = expect(applying).rejects.toThrow("evidence changed");
        release();
        await held;
        await rejected;
        expect(await rows()).toEqual(journal);
        expect(files()).toEqual(disk);
      } finally {
        release();
        await held;
        await finished;
      }
    },
  );

  it("refuses to republish a confirmed receipt reset to pending while queued", async () => {
    const { operation, recover } = await pending(kind);
    await recover(true);
    const { held, release } = await hold(operation.taskspaceId);
    const applying = recover(true);
    const finished = applying.catch(() => undefined);
    try {
      expect((await recover()).status).toBe("already-confirmed");
      await db.update(localFileOperationTable).set({ state: "pending", confirmedAt: null });
      const journal = await rows();
      const disk = files();
      const rejected = expect(applying).rejects.toThrow("evidence changed");
      release();
      await held;
      await rejected;
      expect(await rows()).toEqual(journal);
      expect(files()).toEqual(disk);
    } finally {
      release();
      await held;
      await finished;
    }
  });
});

it("keeps competing claim confirmations idempotent when the first clears a reviewed error", async () => {
  const { operation, recover } = await pending("claim");
  await db.update(localFileOperationTable).set({ error: "Interrupted after writing the marker" });
  const { held, release } = await hold(operation.taskspaceId);
  const confirming = Promise.all([recover(true), recover(true)]);
  const finished = confirming.catch(() => undefined);
  try {
    expect((await recover()).status).toBe("confirmable");
    release();
    await held;
    const outcomes = await confirming;
    expect(outcomes.map(({ status }) => status).sort()).toEqual(["already-confirmed", "confirmed"]);
    expect(await rows()).toMatchObject([{ state: "confirmed", error: null }]);
  } finally {
    release();
    await held;
    await finished;
  }
});
