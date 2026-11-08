import { afterEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import { TagsView } from "../../src/ui.js";
import { HttpClient, StaticClient } from "../../src/client/index.js";
import { tagDataset } from "../client/tags.fixtures.js";
import { tagsView } from "../../src/client/views/tags.js";
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
  const client = new StaticClient({ namespaces: fresh.namespaces, tags: fresh });
  render(TagsView, { props: { ...props, client } });
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
  const client = new HttpClient({ capabilities, fetcher });
  const view = render(TagsView, { props: { ...props, client } });
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Could not refresh tags"),
  );
  await view.rerender({ ...props, client, selection: { ...selection, tag: "docs" } });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.getByText("Seed docs")).toBeInTheDocument();
  finish(Response.json(tagDataset([hit("new", "docs", "Fresh docs")])));
  await waitFor(() => expect(screen.getByText("Fresh docs")).toBeInTheDocument());
});

it("ignores an old client reply after replacement with the same seed and selection", async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = new HttpClient({ capabilities, fetcher });
  const view = render(TagsView, { props: { ...props, client: first } });
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  const next = tagDataset([hit("next", "perf", "New client result")]);
  await view.rerender({
    ...props,
    client: new StaticClient({ namespaces: next.namespaces, tags: next }),
  });
  await waitFor(() => expect(screen.getByText("New client result")).toBeInTheDocument());
  finish(Response.json(tagDataset([hit("late", "perf", "Late reply")])));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("Late reply")).not.toBeInTheDocument();
  expect(screen.getByText("New client result")).toBeInTheDocument();
});

it("uses the host lifecycle without timers and releases it on unmount", async () => {
  vi.useFakeTimers();
  const release = vi.fn();
  const listen = vi.fn(() => release);
  const client = new StaticClient({ namespaces: seed.namespaces, tags: seed });
  const view = render(TagsView, { props: { ...props, client, lifecycle: { listen } } });
  await vi.advanceTimersByTimeAsync(0);
  expect(listen).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  view.unmount();
  expect(release).toHaveBeenCalledOnce();
});
