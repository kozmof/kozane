import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from "../../lib/constants.js";
import { CONFIG_FILE, KOZANE_DIR, defaultConfig, readConfig, writeConfig } from "./config.js";
import { fileSignature } from "../../lib/server/file-signature.js";

let root: string;

function writeRawConfig(raw: unknown): void {
  mkdirSync(join(root, KOZANE_DIR), { recursive: true });
  writeFileSync(join(root, KOZANE_DIR, CONFIG_FILE), JSON.stringify(raw), "utf-8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kozane-config-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("defaultConfig", () => {
  it("uses the built-in server defaults", () => {
    expect(defaultConfig("demo").server).toEqual({
      host: DEFAULT_SERVER_HOST,
      port: DEFAULT_SERVER_PORT,
    });
  });
});

describe("readConfig", () => {
  const taskspace = { defaultDir: ".", searchRoots: ["."] };

  it("falls back to the default host and port when server is omitted", () => {
    writeRawConfig({ name: "demo", taskspace });
    expect(readConfig(root).server).toEqual({
      host: DEFAULT_SERVER_HOST,
      port: DEFAULT_SERVER_PORT,
    });
  });

  it("keeps an explicitly configured port", () => {
    writeRawConfig({ name: "demo", server: { host: "0.0.0.0", port: 5173 }, taskspace });
    expect(readConfig(root).server).toEqual({ host: "0.0.0.0", port: 5173 });
  });

  it("rejects a port outside the valid range", () => {
    writeRawConfig({ name: "demo", server: { port: 70000 }, taskspace });
    expect(() => readConfig(root)).toThrow(/server.port must be between 0 and 65535/);
  });

  it("rejects a non-numeric port", () => {
    writeRawConfig({ name: "demo", server: { port: "5173" }, taskspace });
    expect(() => readConfig(root)).toThrow(/server.port must be a number/);
  });
});

describe("writeConfig", () => {
  beforeEach(() => {
    mkdirSync(join(root, KOZANE_DIR), { recursive: true });
  });

  it("writes a config readConfig accepts", () => {
    writeConfig(root, defaultConfig("demo"));
    expect(readConfig(root).name).toBe("demo");
  });

  /**
   * The readers cache a parsed config and re-validate it with {@link fileSignature}, so a
   * rewrite that the signature cannot see is a rewrite that never takes effect. Two configs
   * differing only in a digit are the same length and land in one filesystem timestamp
   * tick; written in place they keep their inode too, which leaves nothing to tell them
   * apart. Renaming over the target gives the second one an inode of its own.
   */
  it("gives a same-length rewrite a signature of its own", () => {
    const path = join(root, KOZANE_DIR, CONFIG_FILE);
    const base = defaultConfig("demo");

    writeConfig(root, { ...base, ui: { ...base.ui, contentMax: 20_000 } });
    const first = fileSignature(path);
    writeConfig(root, { ...base, ui: { ...base.ui, contentMax: 30_000 } });
    const second = fileSignature(path);

    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(readConfig(root).ui?.contentMax).toBe(30_000);
  });

  it("leaves no temporary file in the workspace", () => {
    writeConfig(root, defaultConfig("demo"));
    expect(readdirSync(join(root, KOZANE_DIR))).toEqual([CONFIG_FILE]);
  });
});
