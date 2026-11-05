import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
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

afterEach(() => vi.unstubAllGlobals());
const capabilities = {
  writable: true,
  persistent: true,
  externalWrites: false,
  taskspaces: false,
  auth: false,
};
function liveWorkspace() {
  render(WorkspacePage, {
    props: {
      data: {
        namespaces: [],
        workspaceRoot: null,
        workspaceName: "Notes",
        readonly: false,
        backendCapabilities: capabilities,
      },
      form: null,
    } as never,
  });
}
it("creates through the backend and displays the committed namespace list", async () => {
  let created = false;
  const row = { id: "new", name: "Research", isDefault: false };
  const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (options?.method === "POST") {
      created = true;
      return new Response(JSON.stringify(row));
    }
    return new Response(JSON.stringify(created ? [row] : []));
  });
  vi.stubGlobal("fetch", fetcher);
  liveWorkspace();
  const input = screen.getByRole("textbox", { name: "New namespace name" });
  await fireEvent.input(input, { target: { value: " Research " } });
  await fireEvent.submit(input.closest("form")!);
  await waitFor(() =>
    expect(screen.getByRole("link", { name: "Research" })).toHaveAttribute("href", "/new"),
  );
  expect(input).toHaveValue("");
  expect(input).toHaveFocus();
  expect(fetcher.mock.calls.find(([, options]) => options?.method === "POST")?.[1]?.body).toBe(
    '{"name":"Research"}',
  );
});
it("keeps the entered name and presents backend validation errors", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, options?: RequestInit) =>
      options?.method === "POST"
        ? new Response('{"message":"name is required"}', {
            status: 400,
            headers: { "content-type": "application/json", "X-Kozane-Error-Code": "validation" },
          })
        : new Response("[]"),
    ),
  );
  liveWorkspace();
  const input = screen.getByRole("textbox", { name: "New namespace name" });
  await fireEvent.input(input, { target: { value: "  " } });
  await fireEvent.submit(input.closest("form")!);
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Namespace name is required."),
  );
  expect(input).toHaveValue("  ");
  expect(screen.getByRole("button", { name: "Create namespace" })).toBeEnabled();
});
it("keeps static namespace pages free of backend requests and creation controls", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  renderWorkspace("Export");
  expect(screen.queryByRole("button", { name: "Create namespace" })).not.toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
});

it("uses supplied navigation for namespace discovery and workspace views", async () => {
  const { createDemoNavigation } = await import("$lib/navigation.js");
  render(WorkspacePage, {
    props: {
      data: {
        namespaces: [{ id: "p1", name: "Research", isDefault: false }],
        workspaceRoot: null,
        workspaceName: "Demo",
        readonly: true,
      },
      form: null,
      navigation: createDemoNavigation({ base: "/demo" }),
    } as never,
  });
  expect(screen.getByRole("link", { name: "Research" })).toHaveAttribute(
    "href",
    "/demo/board/?namespaceId=p1",
  );
  expect(screen.getByRole("link", { name: "Tags" })).toHaveAttribute("href", "/demo/tags/");
  expect(screen.getByRole("link", { name: "Map" })).toHaveAttribute("href", "/demo/map/");
});
