import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAllWarps } from "../../../../db/api/warp.js";
import { addProject } from "../../../../db/api/project.js";
import type { DB } from "../../../../db/tx.js";
import { createTestDB } from "../../../../test-utils/db.js";
import { CANVAS_W, CANVAS_H } from "../../../../lib/constants.js";
import { _resetWorkspaceRootForTest } from "../../../../db/internal/config.js";
import { POST } from "./+server.js";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/project-1/api/warps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function event(db: DB, projectId: string, request: Request) {
  return { locals: { db }, params: { projectId }, request } as never;
}

async function expectHttpRejection(value: unknown, status: number, message: string) {
  await expect(Promise.resolve(value)).rejects.toMatchObject({ status, body: { message } });
}

async function setup() {
  const db = await createTestDB();
  const projectId = await addProject({ db, name: "Project" });
  return { db, projectId };
}

/** A workspace whose `ui` block is the one given, for the canvas the clamp reads. */
function useWorkspaceConfig(ui: Record<string, unknown>): string {
  const root = join(tmpdir(), `kozane-warp-test-${randomUUID()}`);
  mkdirSync(join(root, ".kozane"), { recursive: true });
  writeFileSync(join(root, ".kozane", "config.json"), JSON.stringify({ name: "test", ui }));
  process.env.KOZANE_WORKSPACE_ROOT = root;
  _resetWorkspaceRootForTest();
  return root;
}

describe("POST /[projectId]/api/warps", () => {
  let tmpRoot: string | null = null;
  const prevEnv = process.env.KOZANE_WORKSPACE_ROOT;

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.KOZANE_WORKSPACE_ROOT;
    else process.env.KOZANE_WORKSPACE_ROOT = prevEnv;
    _resetWorkspaceRootForTest();
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  });

  it("stores the warp and returns the whole row", async () => {
    const { db, projectId } = await setup();

    const response = await POST(event(db, projectId, jsonRequest({ posX: 240, posY: 480 })));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ projectId, posX: 240, posY: 480 });
    expect(await getAllWarps({ db, projectId })).toMatchObject([{ posX: 240, posY: 480 }]);
  });

  it("clamps a position outside the canvas and rounds it to a whole pixel", async () => {
    const { db, projectId } = await setup();

    const clamped = await POST(
      event(db, projectId, jsonRequest({ posX: CANVAS_W + 1000, posY: CANVAS_H + 1000 })),
    );
    expect(await clamped.json()).toMatchObject({ posX: CANVAS_W, posY: CANVAS_H });

    const rounded = await POST(event(db, projectId, jsonRequest({ posX: -40.6, posY: 10.6 })));
    expect(await rounded.json()).toMatchObject({ posX: 0, posY: 11 });
  });

  it("clamps to the canvas the workspace is configured with, not the default one", async () => {
    tmpRoot = useWorkspaceConfig({ canvasWidth: 12000, canvasHeight: 9000 });
    const { db, projectId } = await setup();

    // Past the built-in default, but well inside the board this workspace draws.
    const inside = await POST(event(db, projectId, jsonRequest({ posX: 9000, posY: 7000 })));
    expect(await inside.json()).toMatchObject({ posX: 9000, posY: 7000 });

    const outside = await POST(event(db, projectId, jsonRequest({ posX: 20000, posY: 20000 })));
    expect(await outside.json()).toMatchObject({ posX: 12000, posY: 9000 });
  });

  it("rejects a request without a position", async () => {
    const { db, projectId } = await setup();

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ posX: 10 }))),
      400,
      "posX and posY are required",
    );
  });

  it("rejects a position that is not a number", async () => {
    const { db, projectId } = await setup();

    await expectHttpRejection(
      POST(event(db, projectId, jsonRequest({ posX: "10", posY: 0 }))),
      400,
      "posX must be a number",
    );
  });

  it("answers 404 for a project that does not exist", async () => {
    const { db } = await setup();

    await expectHttpRejection(
      POST(event(db, "missing", jsonRequest({ posX: 0, posY: 0 }))),
      404,
      "Project not found",
    );
  });
});
