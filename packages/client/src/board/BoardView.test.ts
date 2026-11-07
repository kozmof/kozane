import { BackendError } from "../backend/contract.js";
import { BackendSignals } from "../backend/signals.js";
import type { KozaneBackend, SnapshotResult } from "../backend/contract.js";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { BoardView } from "../index.js";
import { HttpBackend, StaticBackend } from "../backend/index.js";
import { boardViewProps } from "../../../../src/test-utils/board-view-props.js";
const capabilities = {
  writable: true,
  persistent: true,
  taskspaces: false,
  externalWrites: false,
  auth: false,
};
afterEach(() => vi.unstubAllGlobals());

it("renders the full read-only board with supplied navigation and no requests", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const props = boardViewProps();
  const view = render(BoardView, { props });
  expect(document.title).toBe(props.data.namespace.name);
  expect(
    view.container.querySelector('a[href="/demo/tags/?namespaceId=board#tag=shared"]'),
  ).not.toBeNull();
  expect(screen.queryByRole("textbox", { name: "Write a card" })).not.toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fetcher).not.toHaveBeenCalled();
});

it("isolates pending mutations and navigation guards when the backend changes", async () => {
  const props = boardViewProps();
  let finish!: (value: Response) => void;
  const firstFetch = vi.fn<typeof fetch>().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const secondFetch = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ message: "New backend refusal" }, { status: 400 }));
  const first = new HttpBackend({ capabilities, fetcher: firstFetch });
  const second = new HttpBackend({ capabilities, fetcher: secondFetch });
  const release = vi.fn();
  const beforeNavigate = vi.fn(() => release);
  const host = {
    ...props,
    initialDataApplied: true,
    routing: { ...props.routing, beforeNavigate },
  };
  const view = render(BoardView, { props: { ...host, backend: first } });
  let input = screen.getByRole("textbox", { name: "Write a card" });
  await fireEvent.input(input, { target: { value: "Old draft" } });
  await fireEvent.click(screen.getByRole("button", { name: "Create card" }));
  await waitFor(() => expect(firstFetch).toHaveBeenCalledOnce());
  await view.rerender({ ...host, backend: second });
  expect(release).toHaveBeenCalledOnce();
  expect(beforeNavigate).toHaveBeenCalledTimes(2);
  input = screen.getByRole("textbox", { name: "Write a card" });
  await fireEvent.input(input, { target: { value: "New draft" } });
  finish(Response.json({ message: "Old backend refusal" }, { status: 400 }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(input).toHaveValue("New draft");
  expect(screen.queryByText("Old backend refusal")).not.toBeInTheDocument();
  await fireEvent.click(screen.getByRole("button", { name: "Create card" }));
  await waitFor(() => expect(screen.getByText("New backend refusal")).toBeInTheDocument());
  expect(secondFetch).toHaveBeenCalledOnce();
  expect(firstFetch).toHaveBeenCalledOnce();
  view.unmount();
  expect(release).toHaveBeenCalledTimes(2);
});

it("reuses the view for namespace navigation on the same backend", async () => {
  const props = boardViewProps();
  const next = {
    ...props.data,
    namespace: { id: "next", name: "Next namespace", isDefault: false },
    cards: props.data.cards.map((card) => ({
      ...card,
      id: "next-card",
      content: "Second board card",
    })),
    partitions: props.data.partitions.map((row) => ({ ...row, namespaceId: "next" })),
    layers: props.data.layers.map((row) => ({ ...row, namespaceId: "next" })),
  };
  const backend = new StaticBackend({
    namespaces: [props.data.namespace, next.namespace],
    snapshots: [props.data, next],
  });
  const beforeNavigate = vi.fn(() => () => {});
  const host = { ...props, backend, routing: { ...props.routing, beforeNavigate } };
  const view = render(BoardView, { props: host });
  await view.rerender({ ...host, data: next });
  await waitFor(() =>
    expect(view.container.querySelector('[data-card-id="next-card"]')).not.toBeNull(),
  );
  expect(view.container.querySelector('[data-card-id="card"]')).toBeNull();
  expect(document.title).toBe("Next namespace");
  expect(beforeNavigate).toHaveBeenCalledOnce();
});

it("handles a new card arrival on an already-mounted board", async () => {
  const props = boardViewProps();
  const backend = new HttpBackend({ capabilities, fetcher: vi.fn() });
  const replace = vi.fn();
  const host = {
    ...props,
    backend,
    initialDataApplied: true,
    routing: { ...props.routing, replace },
  };
  const view = render(BoardView, {
    props: {
      ...host,
      readRouteUrl: () => new URL("https://example.test/demo/board/?namespaceId=board"),
    },
  });
  const card = screen.getByRole("button", { name: /Card: Standalone board/ });
  expect(card).toHaveAttribute("aria-pressed", "false");
  await view.rerender({
    ...host,
    readRouteUrl: () =>
      new URL("https://example.test/demo/board/?namespaceId=board&card=card&keep=value#other=kept"),
  });
  await waitFor(() => expect(card).toHaveAttribute("aria-pressed", "true"));
  expect(replace).toHaveBeenCalledWith("/demo/board/?namespaceId=board&keep=value#other=kept");
});

function recoveringHost() {
  const props = boardViewProps();
  const signals = new BackendSignals({ status: "ready" });
  const snapshot = vi.fn<KozaneBackend["snapshot"]>();
  const create = vi.fn<KozaneBackend["cards"]["create"]>();
  const backend = new Proxy(props.backend, {
    get(target, key) {
      if (key === "capabilities") return capabilities;
      if (key === "state") return signals.state;
      if (key === "version") return signals.version;
      if (key === "subscribe") return signals.subscribe.bind(signals);
      if (key === "subscribeState") return signals.subscribeState.bind(signals);
      if (key === "snapshot") return snapshot;
      if (key === "cards") return { ...target.cards, create };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { props: { ...props, backend, initialDataApplied: true }, signals, snapshot, create };
}

it("retains a composer draft and blocks dispatch until recovery data is applied", async () => {
  const f = recoveringHost();
  render(BoardView, { props: f.props });
  const input = screen.getByRole("textbox", { name: "Write a card" });
  const submit = screen.getByRole("button", { name: "Create card" });
  await fireEvent.input(input, { target: { value: "Healthy draft" } });
  f.signals.transition({ status: "recovering" });
  await waitFor(() => expect(submit).toBeDisabled());
  await fireEvent.click(submit);
  expect(f.create).not.toHaveBeenCalled();
  let finish!: (value: SnapshotResult) => void;
  f.snapshot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.signals.transition({ status: "ready" });
  await waitFor(() => expect(f.snapshot).toHaveBeenCalledOnce());
  expect(submit).toBeDisabled();
  expect(input).toHaveValue("Healthy draft");
  finish({ status: "changed", validator: "fresh", data: f.props.data });
  await waitFor(() => expect(submit).toBeEnabled());
  expect(input).toHaveValue("Healthy draft");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("discards generation-scoped drafts and waits for the new generation snapshot", async () => {
  const f = recoveringHost();
  render(BoardView, { props: f.props });
  await fireEvent.input(screen.getByRole("textbox", { name: "Write a card" }), {
    target: { value: "Old generation draft" },
  });
  let finish!: (value: SnapshotResult) => void;
  f.snapshot.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.signals.publish(["snapshot"], undefined, true);
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Write a card" })).toHaveValue(""),
  );
  expect(screen.getByRole("button", { name: "Create card" })).toBeDisabled();
  finish({
    status: "changed",
    validator: "next",
    data: {
      ...f.props.data,
      cards: f.props.data.cards.map((card) => ({ ...card, content: "New generation card" })),
    },
  });
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Write a card" })).toBeEnabled());
  expect(screen.getByRole("textbox", { name: "Write a card" })).toHaveValue("");
  expect(screen.getByText("New generation card")).toBeInTheDocument();
});

it("keeps a late mutation failure out of the replacement generation", async () => {
  const f = recoveringHost();
  let fail!: (reason: unknown) => void;
  f.create.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  f.snapshot.mockResolvedValue({ status: "changed", validator: "fresh", data: f.props.data });
  render(BoardView, { props: f.props });
  await fireEvent.input(screen.getByRole("textbox", { name: "Write a card" }), {
    target: { value: "Old write" },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Create card" }));
  await waitFor(() => expect(f.create).toHaveBeenCalledOnce());
  f.signals.publish(["snapshot"], undefined, true);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Write a card" })).toBeEnabled());
  const input = screen.getByRole("textbox", { name: "Write a card" });
  await fireEvent.input(input, { target: { value: "New generation draft" } });
  fail(new BackendError("validation", "Old generation failure"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("Old generation failure")).not.toBeInTheDocument();
  expect(input).toHaveValue("New generation draft");
  expect(f.create).toHaveBeenCalledOnce();
});

it("keeps board drafts editable while failed snapshot reads are retried", async () => {
  const f = recoveringHost();
  f.snapshot
    .mockRejectedValueOnce(new BackendError("network", "offline"))
    .mockResolvedValue({ status: "changed", validator: "recovered", data: f.props.data });
  render(BoardView, { props: f.props });
  const input = screen.getByRole("textbox", { name: "Write a card" });
  await fireEvent.input(input, { target: { value: "Keep this draft" } });
  f.signals.publish(["snapshot"]);
  expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(input).toHaveValue("Keep this draft");
  expect(input).toBeEnabled();
  await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument(),
  );
  expect(input).toHaveValue("Keep this draft");
  expect(input).toBeEnabled();
  expect(f.snapshot).toHaveBeenCalledTimes(2);
});

it("keeps editing available until polling recovery clears its transient notice", async () => {
  const f = recoveringHost();
  f.snapshot.mockResolvedValue({ status: "changed", validator: "current", data: f.props.data });
  render(BoardView, { props: f.props });
  const input = screen.getByRole("textbox", { name: "Write a card" });
  await fireEvent.input(input, { target: { value: "Still editable" } });
  f.signals.transition({
    status: "ready",
    refreshError: new BackendError("unavailable", "Metadata unavailable"),
  });
  expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(input).toBeEnabled();
  await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(f.snapshot).toHaveBeenCalledOnce());
  expect(screen.getByText(/Could not check workspace changes/)).toBeInTheDocument();
  expect(input).toHaveValue("Still editable");
  f.signals.transition({ status: "ready" });
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument(),
  );
  expect(input).toBeEnabled();
});
