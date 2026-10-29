import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_UI_CONFIG, UI_KNOWN_KEYS } from "../../../lib/ui-config.js";
import {
  type ConfigSnapshot,
  type EditorContext,
  type EditorRequest,
  TOKEN_HEADER,
  configFilePath,
  handleConfigRequest,
} from "./handler.js";
import { configFields } from "./fields.js";

const HOST = "127.0.0.1:40000";
const TOKEN = "secret-token";

const baseConfig = {
  name: "demo",
  server: { host: "127.0.0.1", port: 17173 },
  taskspace: { defaultDir: ".", searchRoots: ["."] },
  ui: { defaultZoom: 1.5, futureSetting: "kept" },
  extra: { kept: true },
};

let root: string;
let ctx: EditorContext;

function writeConfigText(text: string): void {
  writeFileSync(configFilePath(root), text, "utf-8");
}

function readConfigJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(configFilePath(root), "utf-8"));
}

function send(overrides: Partial<EditorRequest> = {}) {
  const response = handleConfigRequest(ctx, {
    method: "GET",
    url: "/api/config",
    headers: { host: HOST, [TOKEN_HEADER]: TOKEN },
    body: "",
    ...overrides,
  });
  return { ...response, data: JSON.parse(String(response.body) || "null") };
}

function load(): ConfigSnapshot {
  const { status, data } = send();
  expect(status).toBe(200);
  return data;
}

function save(changes: Record<string, unknown>, signature = load().signature) {
  return send({
    method: "PUT",
    headers: {
      host: HOST,
      [TOKEN_HEADER]: TOKEN,
      "content-type": "application/json",
      origin: `http://${HOST}`,
    },
    body: JSON.stringify({ signature, changes }),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kozane-config-editor-"));
  mkdirSync(join(root, ".kozane"));
  writeConfigText(JSON.stringify(baseConfig, null, 2));
  // A stand-in for the Vite build in `dist/config-editor`.
  const assetsDir = join(root, "page");
  mkdirSync(join(assetsDir, "assets"), { recursive: true });
  writeFileSync(
    join(assetsDir, "index.html"),
    '<script type="module" src="./assets/index-abc.js"></script>',
  );
  writeFileSync(join(assetsDir, "assets", "index-abc.js"), "console.log(1)");
  writeFileSync(join(root, "secret.txt"), "not served");
  ctx = { root, token: TOKEN, allowedHosts: new Set([HOST]), assetsDir };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("access", () => {
  const page = (url: string) =>
    handleConfigRequest(ctx, { method: "GET", url, headers: { host: HOST }, body: "" });

  it("serves the built page without the token, under a same-origin CSP", () => {
    const response = page("/?token=whatever");
    expect(response.status).toBe(200);
    expect(response.headers["Content-Type"]).toContain("text/html");
    expect(String(response.body)).toContain("./assets/index-abc.js");
    expect(response.headers["Content-Security-Policy"]).toContain("script-src 'self'");
    expect(response.headers["Content-Security-Policy"]).not.toContain("unsafe-inline");
    expect(response.headers["Referrer-Policy"]).toBe("no-referrer");
  });

  it("serves the built assets with their content type", () => {
    const response = page("/assets/index-abc.js");
    expect(response.status).toBe(200);
    expect(response.headers["Content-Type"]).toContain("text/javascript");
    expect(String(response.body)).toBe("console.log(1)");
  });

  it("serves nothing outside the assets directory", () => {
    for (const url of [
      "/assets/../../secret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/assets/%2e%2e",
      "/assets/sub/index-abc.js",
      "/assets/missing.js",
      "/secret.txt",
    ]) {
      expect(page(url).status, url).toBe(404);
    }
  });

  it("says how to build the page when it is missing", () => {
    rmSync(ctx.assetsDir, { recursive: true });
    const response = page("/");
    expect(response.status).toBe(503);
    expect(String(response.body)).toContain("pnpm build");
  });

  it("refuses the API without the token", () => {
    expect(send({ headers: { host: HOST } }).status).toBe(403);
    expect(send({ headers: { host: HOST, [TOKEN_HEADER]: "wrong" } }).status).toBe(403);
  });

  it("refuses an unexpected Host header", () => {
    expect(send({ headers: { host: "evil.example:40000", [TOKEN_HEADER]: TOKEN } }).status).toBe(
      421,
    );
    expect(send({ headers: { [TOKEN_HEADER]: TOKEN } }).status).toBe(421);
  });

  it("refuses a save from another origin", () => {
    const response = send({
      method: "PUT",
      headers: {
        host: HOST,
        [TOKEN_HEADER]: TOKEN,
        "content-type": "application/json",
        origin: "http://evil.example",
      },
      body: JSON.stringify({ signature: load().signature, changes: {} }),
    });
    expect(response.status).toBe(403);
  });

  it("answers 404 for other paths", () => {
    expect(send({ url: "/nope" }).status).toBe(404);
  });
});

describe("reading", () => {
  it("returns the fields, the raw values in the file, and the issues", () => {
    const snapshot = load();
    expect(snapshot.values).toMatchObject({
      name: "demo",
      "server.port": 17173,
      "taskspace.searchRoots": ["."],
      "ui.defaultZoom": 1.5,
    });
    expect(snapshot.values).not.toHaveProperty("ui.zoomStep");
    expect(snapshot.issues.map((issue) => issue.path)).toEqual(["extra", "ui.futureSetting"]);
    expect(snapshot.readError).toBeUndefined();
  });

  it("still opens a config with errors so they can be fixed", () => {
    writeConfigText(JSON.stringify({ ...baseConfig, ui: { defaultZoom: "big" } }));
    const snapshot = load();
    expect(snapshot.values["ui.defaultZoom"]).toBe("big");
    expect(snapshot.issues).toContainEqual(
      expect.objectContaining({ path: "ui.defaultZoom", severity: "error" }),
    );
  });

  it("reports a file that is not valid JSON", () => {
    writeConfigText("{ nope");
    expect(load().readError).toContain("is not valid JSON");
  });
});

describe("saving", () => {
  it("applies only the changed fields and keeps everything else", () => {
    const response = save({ "ui.showZoomControl": false, "server.port": 18000 });

    expect(response.status).toBe(200);
    expect(response.data.saved).toBe(true);
    expect(readConfigJson()).toEqual({
      ...baseConfig,
      server: { host: "127.0.0.1", port: 18000 },
      ui: { defaultZoom: 1.5, futureSetting: "kept", showZoomControl: false },
    });
    expect(response.data.snapshot.values["ui.showZoomControl"]).toBe(false);
  });

  it("removes a key when the change is null, so its default applies", () => {
    expect(save({ "ui.defaultZoom": null }).status).toBe(200);
    expect(readConfigJson().ui).toEqual({ futureSetting: "kept" });
  });

  it("creates a missing section", () => {
    const { ui: _ui, ...withoutUi } = baseConfig;
    writeConfigText(JSON.stringify(withoutUi));
    expect(save({ "ui.editorVimMode": true }).status).toBe(200);
    expect(readConfigJson().ui).toEqual({ editorVimMode: true });
  });

  it("refuses values the doctor would reject and leaves the file alone", () => {
    const before = readFileSync(configFilePath(root), "utf-8");
    const response = save({ "ui.defaultZoom": 42 });

    expect(response.status).toBe(422);
    expect(response.data.issues).toContainEqual(
      expect.objectContaining({ path: "ui.defaultZoom", severity: "error" }),
    );
    expect(readFileSync(configFilePath(root), "utf-8")).toBe(before);
  });

  it("saves despite warnings such as a shared shortcut", () => {
    const response = save({ "ui.setWarpShortcut": DEFAULT_UI_CONFIG.toggleFootersShortcut });
    expect(response.status).toBe(200);
  });

  it("refuses to remove a required field", () => {
    expect(save({ name: null }).status).toBe(400);
  });

  it("refuses a path that is not a setting", () => {
    expect(save({ "extra.kept": false }).status).toBe(400);
    expect(save({ "ui.__proto__.polluted": 1 }).status).toBe(400);
  });

  it("refuses to overwrite a file that changed after the page loaded it", () => {
    const { signature } = load();
    writeConfigText(JSON.stringify({ ...baseConfig, name: "edited elsewhere" }, null, 2) + "\n\n");

    const response = save({ "ui.editorVimMode": true }, signature);

    expect(response.status).toBe(409);
    expect(readConfigJson().name).toBe("edited elsewhere");
  });

  it("refuses a body that is not JSON", () => {
    const response = send({
      method: "PUT",
      headers: { host: HOST, [TOKEN_HEADER]: TOKEN, "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
  });

  it("refuses a save when the file is not valid JSON", () => {
    writeConfigText("{ nope");
    expect(save({ name: "x" }, load().signature).status).toBe(409);
  });
});

describe("configFields", () => {
  it("covers every ui setting plus the top-level and section fields", () => {
    const paths = configFields().map((field) => field.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "name",
        "server.host",
        "server.port",
        "taskspace.defaultDir",
        "taskspace.searchRoots",
        ...UI_KNOWN_KEYS.map((key) => `ui.${key}`),
      ]),
    );
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("gives each kind of setting the matching control", () => {
    const byPath = new Map(configFields().map((field) => [field.path, field]));
    expect(byPath.get("ui.showZoomControl")).toMatchObject({ kind: "boolean", defaultValue: true });
    expect(byPath.get("ui.defaultZoom")).toMatchObject({ kind: "number", min: 0.1, max: 10 });
    expect(byPath.get("ui.newCardPlacement")).toMatchObject({ kind: "choice" });
    expect(byPath.get("ui.setWarpShortcut")).toMatchObject({ kind: "shortcut" });
    expect(byPath.get("ui.defaultFontFamily")).toMatchObject({ kind: "string" });
    expect(byPath.get("taskspace.searchRoots")).toMatchObject({ kind: "list", required: true });
  });
});
