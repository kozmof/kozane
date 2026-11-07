import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { MapView } from "../index.js";
import { HttpBackend, StaticBackend } from "../backend/index.js";
import { mapView } from "../backend/views/map.js";
import { createDemoNavigation } from "../../../../src/lib/navigation.js";
import { mapDataset } from "../../../../src/test-utils/map-dataset.js";
import { DEFAULT_ZOOM, zoomPercent } from "./lib/view.js";
const selection = { namespaceId: "p1", tag: null, day: null };
const seed = mapDataset();
const props = {
  data: mapView(seed, { namespaceId: null, tag: null, day: null, zoomStep: 0.05 }),
  selection,
  navigation: createDemoNavigation({ base: "/demo" }),
  retryIntervalMs: false as const,
};
const capabilities = {
  writable: true,
  persistent: true,
  taskspaces: false,
  externalWrites: false,
  auth: false,
};
const partition = (container: HTMLElement, name: string) =>
  container.querySelector(`a[aria-label^="${name},"]`);

it("preserves zoom and pan across backend replacement and rejects the old reply", async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = new HttpBackend({ capabilities, fetcher });
  const view = render(MapView, { props: { ...props, backend: first } });
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await fireEvent.click(screen.getByLabelText("Zoom in"));
  const surface = view.container.querySelector('[role="presentation"]')!;
  const beforePan = partition(view.container, "Seed partition")!
    .querySelector("rect")!
    .getAttribute("x");
  await fireEvent.pointerDown(surface, { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
  await fireEvent.pointerMove(surface, { pointerId: 1, clientX: 300, clientY: 240 });
  await fireEvent.pointerUp(surface, { pointerId: 1 });
  const panned = partition(view.container, "Seed partition")!
    .querySelector("rect")!
    .getAttribute("x");
  expect(panned).not.toBe(beforePan);
  const next = mapDataset("Fresh partition");
  await view.rerender({
    ...props,
    backend: new StaticBackend({ namespaces: next.namespaces, map: next }),
  });
  await waitFor(() => expect(partition(view.container, "Fresh partition")).not.toBeNull());
  expect(partition(view.container, "Fresh partition")).toHaveAttribute(
    "href",
    "/demo/board/?namespaceId=p1",
  );
  expect(partition(view.container, "Fresh partition")!.querySelector("rect")).toHaveAttribute(
    "x",
    panned,
  );
  expect(screen.getByText(`${zoomPercent(DEFAULT_ZOOM + 0.05)}%`)).toBeInTheDocument();
  finish(Response.json(mapDataset("Late partition")));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(partition(view.container, "Late partition")).toBeNull();
  expect(partition(view.container, "Fresh partition")).not.toBeNull();
});

it("discards an old selection's projection while the next namespace loads", async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(mapDataset("First filtered partition")))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const backend = new HttpBackend({ capabilities, fetcher });
  const view = render(MapView, { props: { ...props, backend } });
  await waitFor(() => expect(partition(view.container, "First filtered partition")).not.toBeNull());
  await view.rerender({ ...props, backend, selection: { ...selection, namespaceId: "p2" } });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(partition(view.container, "First filtered partition")).toBeNull();
  const next = mapDataset("Excluded partition");
  next.partitions[1].name = "Second selection partition";
  finish(Response.json(next));
  await waitFor(() =>
    expect(partition(view.container, "Second selection partition")).not.toBeNull(),
  );
  expect(partition(view.container, "Excluded partition")).toBeNull();
});

it("uses injected visibility and wake callbacks and releases the lifecycle", async () => {
  let hidden = true;
  let wake!: () => void;
  const release = vi.fn();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(mapDataset("Visible partition")));
  const backend = new HttpBackend({ capabilities, fetcher });
  const view = render(MapView, {
    props: {
      ...props,
      backend,
      isHidden: () => hidden,
      lifecycle: {
        listen(callback) {
          wake = callback;
          return release;
        },
      },
    },
  });
  expect(fetcher).not.toHaveBeenCalled();
  hidden = false;
  wake();
  await waitFor(() => expect(partition(view.container, "Visible partition")).not.toBeNull());
  view.unmount();
  expect(release).toHaveBeenCalledOnce();
});

it("retains map data and viewport while a failed refresh is retried", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementation(async () => Response.json(mapDataset("Recovered partition")));
  const backend = new HttpBackend({ capabilities, fetcher });
  const view = render(MapView, { props: { ...props, backend } });
  await fireEvent.click(screen.getByLabelText("Zoom in"));
  const zoom = `${zoomPercent(DEFAULT_ZOOM + 0.05)}%`;
  expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(partition(view.container, "Seed partition")).not.toBeNull();
  await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(partition(view.container, "Recovered partition")).not.toBeNull());
  expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  expect(screen.getByText(zoom)).toBeInTheDocument();
});
