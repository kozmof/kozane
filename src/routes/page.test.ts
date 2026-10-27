import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
import WorkspacePage from "./+page.svelte";

function renderWorkspace(workspaceName: string | null) {
  render(WorkspacePage, {
    props: {
      data: { namespaces: [], workspaceRoot: null, workspaceName, readonly: true },
      form: null,
    } as never,
  });
}

describe("Workspace page", () => {
  it("names the browser tab after the workspace", () => {
    renderWorkspace("my-notes");
    expect(document.title).toBe("my-notes");
  });

  it("falls back to Kozane when no workspace name is known", () => {
    renderWorkspace(null);
    expect(document.title).toBe("Kozane");
  });
});
