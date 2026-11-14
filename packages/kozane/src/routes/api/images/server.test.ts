import { expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDB } from "../../../test-utils/db.js";
const workspace = vi.hoisted(() => ({ root: "" }));
vi.mock("../../../db/internal/config.js", () => ({ getWorkspaceRoot: () => workspace.root }));
import { POST } from "./+server";
import { GET } from "./[name]/+server";
it("uploads and serves validated images with sandbox headers", async () => {
  workspace.root = await mkdtemp(join(tmpdir(), "kozane-image-route-"));
  const db = await createTestDB();
  const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"/>';
  try {
    const file = new File([source], "drawing.svg", { type: "image/svg+xml" });
    const form = new FormData();
    form.set("image", file);
    // Supply the parsed form directly so this unit test uses one File implementation.
    const result = await POST({
      locals: { db },
      request: { method: "POST", url: "http://localhost/api/images", formData: async () => form },
    } as unknown as Parameters<typeof POST>[0]);
    const { url } = await result.json();
    const response = await GET({ params: { name: url.split("/").pop() } } as Parameters<
      typeof GET
    >[0]);
    expect(await response.text()).toBe(source);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    await expect(
      GET({ params: { name: "../secret" } } as Parameters<typeof GET>[0]),
    ).rejects.toMatchObject({ status: 404 });
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

it("reports storage failures as generic server errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "kozane-storage-failure-"));
  workspace.root = join(root, "not-a-directory");
  await writeFile(workspace.root, "file");
  const db = await createTestDB();
  const form = new FormData();
  form.set("image", new File(["<svg/>"], "drawing.svg"));
  try {
    await expect(
      POST({ locals: { db }, request: { formData: async () => form } } as unknown as Parameters<
        typeof POST
      >[0]),
    ).rejects.toMatchObject({ status: 500, body: { message: "Unable to store image" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
