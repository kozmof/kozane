import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import {
  type EditorContext,
  configFilePath,
  handleConfigRequest,
} from "../cli/lib/config-editor/handler.js";
import App from "./App.svelte";

/**
 * Render the page against the real handler. `fetch` goes straight to `handleConfigRequest`,
 * so these cover the page and the API together without a socket.
 */

const HOST = "127.0.0.1:40000";
const TOKEN = "page-token";

let root: string;
let ctx: EditorContext;

function readConfigJson(): Record<string, any> {
  return JSON.parse(readFileSync(configFilePath(root), "utf-8"));
}

function writeConfigJson(config: unknown): void {
  writeFileSync(configFilePath(root), JSON.stringify(config));
}

async function openPage(token: string | null = TOKEN) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = { host: HOST };
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const response = handleConfigRequest(ctx, {
      method: init.method ?? "GET",
      url,
      headers,
      body: typeof init.body === "string" ? init.body : "",
    });
    return { status: response.status, json: async () => JSON.parse(String(response.body)) };
  });
  const view = render(App, { props: { token } });
  if (token) await waitFor(() => expect(row("name")).toBeTruthy());
  return view;
}

function row(path: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-path="${path}"]`)!;
}

function control(path: string): HTMLInputElement {
  return row(path).querySelector<HTMLInputElement>("input, select, textarea")!;
}

const saveButton = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
const statusText = () => screen.getByRole("status").textContent ?? "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kozane-config-page-"));
  mkdirSync(join(root, ".kozane"));
  writeConfigJson({
    name: "demo",
    taskspace: { defaultDir: ".", searchRoots: ["."] },
    ui: { defaultZoom: 1.5 },
  });
  ctx = { root, token: TOKEN, allowedHosts: new Set([HOST]), assetsDir: root };
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("config page", () => {
  it("shows the file's values, with defaults for absent keys", async () => {
    await openPage();

    expect(control("name").value).toBe("demo");
    expect(control("ui.defaultZoom").value).toBe("1.5");
    expect(control("ui.showZoomControl").checked).toBe(true);
    expect(control("taskspace.searchRoots").value).toBe(".");
    expect(control("ui.newCardPlacement").value).toBe("vertical-list");
    expect(saveButton().disabled).toBe(true);
  });

  it("saves only the changed settings", async () => {
    await openPage();

    await fireEvent.click(control("ui.showZoomControl"));
    await fireEvent.input(control("name"), { target: { value: "renamed" } });
    expect(row("name").className).not.toBe(row("server.host").className);
    expect(saveButton().disabled).toBe(false);
    await fireEvent.click(saveButton());

    await waitFor(() => expect(statusText()).toContain("Saved"));
    expect(readConfigJson()).toEqual({
      name: "renamed",
      taskspace: { defaultDir: ".", searchRoots: ["."] },
      ui: { defaultZoom: 1.5, showZoomControl: false },
    });
    expect(saveButton().disabled).toBe(true);
  });

  it("saves edited numbers, choices, and lists", async () => {
    await openPage();

    await fireEvent.input(control("ui.zoomStep"), { target: { value: "0.1" } });
    await fireEvent.change(control("ui.newCardPlacement"), { target: { value: "grid" } });
    await fireEvent.input(control("taskspace.searchRoots"), {
      target: { value: ".\n  ../notes  \n\n" },
    });
    await fireEvent.click(saveButton());

    await waitFor(() => expect(statusText()).toContain("Saved"));
    expect(readConfigJson().ui).toMatchObject({ zoomStep: 0.1, newCardPlacement: "grid" });
    expect(readConfigJson().taskspace.searchRoots).toEqual([".", "../notes"]);
  });

  it("records a shortcut from a key press", async () => {
    await openPage();

    await fireEvent.keyDown(control("ui.setWarpShortcut"), { key: "Shift" });
    await fireEvent.keyDown(control("ui.setWarpShortcut"), { key: "k" });
    expect(control("ui.setWarpShortcut").value).toBe("k");
    await fireEvent.click(saveButton());

    await waitFor(() => expect(statusText()).toContain("Saved"));
    expect(readConfigJson().ui.setWarpShortcut).toBe("k");
  });

  it("binds no key with None", async () => {
    await openPage();

    await fireEvent.click(
      row("ui.removeWarpShortcut").querySelector<HTMLButtonElement>('button[title="Disable this shortcut"]')!,
    );
    await fireEvent.click(saveButton());

    await waitFor(() => expect(statusText()).toContain("Saved"));
    expect(readConfigJson().ui.removeWarpShortcut).toBe("");
  });

  it("puts a setting back to its default", async () => {
    await openPage();

    await fireEvent.click(row("ui.defaultZoom").querySelector("button")!);
    expect(control("ui.defaultZoom").value).toBe("1");
    await fireEvent.click(saveButton());

    await waitFor(() => expect(statusText()).toContain("Saved"));
    expect(readConfigJson().ui).toEqual({});
  });

  it("shows the errors next to the setting when a save is refused", async () => {
    await openPage();

    await fireEvent.input(control("ui.defaultZoom"), { target: { value: "42" } });
    await fireEvent.click(saveButton());

    await waitFor(() =>
      expect(row("ui.defaultZoom").querySelector('[data-issue="error"]')?.textContent).toContain(
        "ui.defaultZoom must be between 0.1 and 10",
      ),
    );
    expect(readConfigJson().ui.defaultZoom).toBe(1.5);
    expect(saveButton().disabled).toBe(false);
  });

  it("refuses to overwrite a file changed elsewhere", async () => {
    await openPage();
    writeConfigJson({ name: "edited elsewhere", taskspace: { defaultDir: ".", searchRoots: [] } });

    await fireEvent.click(control("ui.editorVimMode"));
    await fireEvent.click(saveButton());

    await waitFor(() => expect(statusText()).toContain("changed on disk"));
    expect(readConfigJson().name).toBe("edited elsewhere");
  });

  it("discards changes by reloading the file", async () => {
    await openPage();

    await fireEvent.input(control("name"), { target: { value: "renamed" } });
    await fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));

    await waitFor(() => expect(control("name").value).toBe("demo"));
    expect(saveButton().disabled).toBe(true);
  });

  it("lists warnings, including ones for keys the page does not show", async () => {
    writeConfigJson({
      name: "demo",
      taskspace: { defaultDir: ".", searchRoots: ["."] },
      ui: { zoomStp: 0.1 },
    });
    await openPage();

    expect(document.querySelector('[data-notice="warning"]')?.textContent).toContain(
      'ui.zoomStp is not a known key — did you mean "zoomStep"? (not on this page)',
    );
  });

  it("shows a file that is not valid JSON read-only", async () => {
    writeFileSync(configFilePath(root), "{ nope");
    await openPage();

    expect(screen.getAllByText(/is not valid JSON/).length).toBeGreaterThan(0);
    expect(control("name").disabled).toBe(true);
  });

  it("filters settings by name", async () => {
    await openPage();

    await fireEvent.input(screen.getByLabelText("Filter settings"), {
      target: { value: "layer icon" },
    });

    const paths = [...document.querySelectorAll<HTMLElement>("[data-path]")].map(
      (element) => element.dataset.path,
    );
    expect(paths).toEqual(["ui.showLayerControl"]);
  });

  it("explains how to open the page when the token is missing", async () => {
    await openPage(null);
    expect(statusText()).toContain("kozane config open");
  });
});
