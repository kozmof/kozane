import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { BoardView } from "../index.js";
import { HttpBackend, StaticBackend } from "../../backend/index.js";
import { boardViewProps } from "../../../test-utils/board-view-props.js";
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
