import { afterEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import { TagsView } from "../../src/ui.js";
import { HttpClient, StaticClient } from "../../src/backend/index.js";
import { tagDataset } from "../backend/tags.fixtures.js";
import { tagsView } from "../../src/backend/views/tags.js";
import { createDemoNavigation } from "../../src/navigation.js";
import type { TagHit } from "../../../kozane/src/lib/types.js";
const hit = (id: string, tag: string, excerpt: string): TagHit => ({
  tag,
  source: { kind: "card", cardId: id },
  excerpt,
});
const selection = { tag: "perf", namespaceId: null };
const navigation = createDemoNavigation({ base: "/demo" });
const seed = tagDataset([hit("old", "perf", "Seed result"), hit("docs", "docs", "Seed docs")]);
const data = tagsView(seed, { ...selection, staticExport: true });
const props = { data, selection, navigation, retryIntervalMs: false as const };
const capabilities = {
  writable: true,
  persistent: true,
  taskspaces: false,
  externalWrites: false,
  auth: false,
};
afterEach(() => vi.useRealTimers());

it("renders refreshed card labels and partition metadata together", async () => {
  const fresh = tagDataset([hit("new", "perf", "Fresh content")]);
  fresh.cardPartitions[0].partitionId = "b2";
  fresh.index.cardData.new = { namespaceId: "p1", partitionId: "b2", updatedDay: "2026-09-06" };
  fresh.partitions = { b2: { name: "New partition", dot: "#123456" } };
  const backend = new StaticClient({ namespaces: fresh.namespaces, tags: fresh });
  render(TagsView, { props: { ...props, backend } });
  await waitFor(() => expect(screen.getByText("Fresh content")).toBeInTheDocument());
  expect(screen.getByText("New partition")).toBeInTheDocument();
  expect(screen.getByText("Fresh content").closest("a")).toHaveAttribute(
    "href",
    "/demo/board/?namespaceId=p1&card=new",
  );
  expect(screen.queryByText("Seed result")).not.toBeInTheDocument();
});

it("clears an old selection's error while the new selection loads", async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ message: "offline" }, { status: 503 }))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const backend = new HttpClient({ capabilities, fetcher });
  const view = render(TagsView, { props: { ...props, backend } });
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Could not refresh tags"),
  );
  await view.rerender({ ...props, backend, selection: { ...selection, tag: "docs" } });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByText("Seed docs")).toBeInTheDocument();
  finish(Response.json(tagDataset([hit("new", "docs", "Fresh docs")])));
  await waitFor(() => expect(screen.getByText("Fresh docs")).toBeInTheDocument());
});

it("ignores an old backend reply after replacement with the same seed and selection", async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = new HttpClient({ capabilities, fetcher });
  const view = render(TagsView, { props: { ...props, backend: first } });
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  const next = tagDataset([hit("next", "perf", "New backend result")]);
  await view.rerender({
    ...props,
    backend: new StaticClient({ namespaces: next.namespaces, tags: next }),
  });
  await waitFor(() => expect(screen.getByText("New backend result")).toBeInTheDocument());
  finish(Response.json(tagDataset([hit("late", "perf", "Late reply")])));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("Late reply")).not.toBeInTheDocument();
  expect(screen.getByText("New backend result")).toBeInTheDocument();
});

it("uses the host lifecycle without timers and releases it on unmount", async () => {
  vi.useFakeTimers();
  const release = vi.fn();
  const listen = vi.fn(() => release);
  const backend = new StaticClient({ namespaces: seed.namespaces, tags: seed });
  const view = render(TagsView, { props: { ...props, backend, lifecycle: { listen } } });
  await vi.advanceTimersByTimeAsync(0);
  expect(listen).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  view.unmount();
  expect(release).toHaveBeenCalledOnce();
});
