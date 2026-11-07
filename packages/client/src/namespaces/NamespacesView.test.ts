import { BackendSignals } from "../../../../src/lib/backend/signals.js";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { NamespacesView } from "../index.js";
import { HttpBackend, StaticBackend } from "../../../../src/lib/backend/index.js";
import { createDemoNavigation } from "../../../../src/lib/navigation.js";
const navigation = createDemoNavigation({ base: "/demo" });
const capabilities = {
  writable: true,
  persistent: true,
  externalWrites: false,
  taskspaces: false,
  auth: false,
};
const rows = [{ id: "one", name: "Research", isDefault: true }];
const props = { initialNamespaces: rows, navigation, retryIntervalMs: false as const };
afterEach(() => vi.unstubAllGlobals());

it("renders a read-only index with supplied navigation and generic empty guidance", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const backend = new StaticBackend({ namespaces: rows });
  const view = render(NamespacesView, { props: { ...props, backend } });
  expect(screen.getByRole("link", { name: /Research/ })).toHaveAttribute(
    "href",
    "/demo/board/?namespaceId=one",
  );
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await view.rerender({
    ...props,
    initialNamespaces: [],
    backend: new StaticBackend({ namespaces: [] }),
  });
  expect(screen.getByText("No namespaces yet.")).toBeInTheDocument();
  expect(screen.queryByText(/kozane namespace/)).not.toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps progressive form attributes and app-supplied errors", () => {
  const backend = new HttpBackend({
    capabilities,
    fetcher: vi.fn().mockResolvedValue(Response.json(rows)),
  });
  render(NamespacesView, {
    props: {
      ...props,
      backend,
      createAction: "/namespace-create",
      formError: "Choose another name",
      workspaceLabel: "My workspace",
    },
  });
  expect(screen.getByRole("heading")).toHaveTextContent("My workspace");
  const input = screen.getByRole("textbox", { name: "New namespace name" });
  expect(input.closest("form")).toHaveAttribute("method", "POST");
  expect(input.closest("form")).toHaveAttribute("action", "/namespace-create");
  expect(screen.getByRole("alert")).toHaveTextContent("Choose another name");
});

it("disposes the old backend subscription and rejects late rows after replacement", async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = new HttpBackend({ capabilities, fetcher });
  const subscribe = first.subscribe.bind(first);
  const stopped = vi.fn();
  vi.spyOn(first, "subscribe").mockImplementation((listener) => {
    const stop = subscribe(listener);
    return () => {
      stop();
      stopped();
    };
  });
  const view = render(NamespacesView, { props: { ...props, backend: first } });
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  const nextRows = [{ id: "next", name: "New backend", isDefault: false }];
  await view.rerender({
    ...props,
    initialNamespaces: nextRows,
    backend: new StaticBackend({ namespaces: nextRows }),
  });
  expect(stopped).toHaveBeenCalledOnce();
  finish(Response.json([{ id: "stale", name: "Old reply", isDefault: false }]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.getByRole("link", { name: "New backend" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Old reply" })).not.toBeInTheDocument();
  view.unmount();
});

it("does not clear a new backend's draft when an old creation finishes", async () => {
  let finish!: (value: Response) => void;
  const first = new HttpBackend({
    capabilities,
    fetcher: vi.fn<typeof fetch>().mockImplementation(async (_url, options) =>
      options?.method === "POST"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Response.json(rows),
    ),
  });
  const view = render(NamespacesView, { props: { ...props, backend: first } });
  const input = screen.getByRole("textbox", { name: "New namespace name" });
  await fireEvent.input(input, { target: { value: "Old draft" } });
  await fireEvent.submit(input.closest("form")!);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  const second = new HttpBackend({
    capabilities,
    fetcher: vi.fn().mockResolvedValue(Response.json(rows)),
  });
  await view.rerender({ ...props, backend: second });
  await fireEvent.input(input, { target: { value: "New draft" } });
  finish(Response.json({ id: "created", name: "Old draft", isDefault: false }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(input).toHaveValue("New draft");
  expect(screen.getByRole("button", { name: "Create namespace" })).toBeEnabled();
});

it("retains the namespace draft while recovery blocks submission", async () => {
  const signals = new BackendSignals({ status: "ready" });
  let finish!: (value: Response) => void;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(rows))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const backend = new HttpBackend({ capabilities, fetcher });
  vi.spyOn(backend, "state", "get").mockImplementation(() => signals.state);
  vi.spyOn(backend, "version", "get").mockImplementation(() => signals.version);
  vi.spyOn(backend, "subscribe").mockImplementation(signals.subscribe.bind(signals));
  vi.spyOn(backend, "subscribeState").mockImplementation(signals.subscribeState.bind(signals));
  render(NamespacesView, { props: { ...props, backend } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const input = screen.getByRole("textbox", { name: "New namespace name" });
  await fireEvent.input(input, { target: { value: "Retained name" } });
  signals.transition({ status: "recovering" });
  const button = screen.getByRole("button", { name: "Create namespace" });
  await waitFor(() => expect(button).toBeDisabled());
  await fireEvent.submit(input.closest("form")!);
  expect(fetcher).toHaveBeenCalledOnce();
  signals.transition({ status: "ready" });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(button).toBeDisabled();
  finish(Response.json(rows));
  await waitFor(() => expect(button).toBeEnabled());
  expect(input).toHaveValue("Retained name");
});

it("retains namespace links and retries a failed metadata refresh", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementation(async () => Response.json([{ ...rows[0], name: "Recovered namespace" }]));
  const backend = new HttpBackend({ capabilities, fetcher });
  render(NamespacesView, { props: { ...props, backend } });
  expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Research/ })).toBeInTheDocument();
  await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("link", { name: /Recovered namespace/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
});
