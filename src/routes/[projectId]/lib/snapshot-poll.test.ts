import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Activity } from "./activity.js";
import { SNAPSHOT_POLL_MS, startSnapshotPoll } from "./snapshot-poll.js";
import type { ProjectDataSnapshot } from "$lib/types.js";

// A whole snapshot, not a stand-in for one: the poll reads what it is sent through
// `readProjectSnapshot` and drops a body that is not a snapshot, so a fixture missing half
// its lists would be testing the drop path in every case. No cast, for the same reason.
const SNAPSHOT: ProjectDataSnapshot = {
  project: { id: "p1" },
  cards: [],
  bundles: [],
  layers: [],
  warps: [],
  scopes: [],
  scopeRels: [],
  glueRels: [],
  taskspaces: [],
};

function snapshotResponse(etag?: string): Response {
  return new Response(JSON.stringify(SNAPSHOT), {
    status: 200,
    headers: etag ? { etag } : {},
  });
}

type Harness = {
  fetcher: ReturnType<typeof vi.fn>;
  applied: ProjectDataSnapshot[];
  activity: Activity;
  hidden: { value: boolean };
  stop: () => void;
};

function start(fetcher: ReturnType<typeof vi.fn>): Harness {
  const applied: ProjectDataSnapshot[] = [];
  const activity = new Activity();
  const hidden = { value: false };
  const stop = startSnapshotPoll({
    fetcher: fetcher as unknown as typeof fetch,
    projectId: () => "p1",
    activities: [activity],
    apply: (snapshot) => applied.push(snapshot),
    isHidden: () => hidden.value,
  });
  return { fetcher, applied, activity, hidden, stop };
}

/** One poll tick, plus the microtasks the response is handled in. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(SNAPSHOT_POLL_MS);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startSnapshotPoll", () => {
  it("applies a snapshot the server answers with", async () => {
    const harness = start(vi.fn().mockResolvedValue(snapshotResponse()));
    await tick();
    expect(harness.fetcher).toHaveBeenCalledWith("/p1/api/snapshot", expect.anything());
    expect(harness.applied).toEqual([SNAPSHOT]);
    harness.stop();
  });

  it("sends the tag of the snapshot it holds on the next poll", async () => {
    const harness = start(vi.fn().mockResolvedValue(snapshotResponse('"abc"')));
    await tick();
    await tick();
    const [, second] = harness.fetcher.mock.calls;
    expect(second[1]).toMatchObject({ headers: { "if-none-match": '"abc"' } });
    harness.stop();
  });

  it("sends no tag when the answer carried none", async () => {
    const harness = start(vi.fn().mockResolvedValue(snapshotResponse()));
    await tick();
    await tick();
    const [, second] = harness.fetcher.mock.calls;
    expect(second[1].headers).toBeUndefined();
    harness.stop();
  });

  it("applies nothing on a 304", async () => {
    const harness = start(vi.fn().mockResolvedValue(new Response(null, { status: 304 })));
    await tick();
    expect(harness.applied).toEqual([]);
    harness.stop();
  });

  it("applies nothing when the request fails", async () => {
    const harness = start(vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    await tick();
    expect(harness.applied).toEqual([]);
    harness.stop();
  });

  it("keeps polling after a rejected request", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(snapshotResponse());
    const harness = start(fetcher);
    await tick();
    expect(harness.applied).toEqual([]);
    await tick();
    expect(harness.applied).toEqual([SNAPSHOT]);
    harness.stop();
  });

  it("does not poll while the tab is hidden", async () => {
    const harness = start(vi.fn().mockResolvedValue(snapshotResponse()));
    harness.hidden.value = true;
    await tick();
    expect(harness.fetcher).not.toHaveBeenCalled();
    harness.stop();
  });

  it("does not poll while work is in flight", async () => {
    const harness = start(vi.fn().mockResolvedValue(snapshotResponse()));
    harness.activity.begin();
    await tick();
    expect(harness.fetcher).not.toHaveBeenCalled();
    harness.stop();
  });

  it("drops an answer when work started and finished while it was on its way", async () => {
    const harness = start(
      vi.fn().mockImplementation(async () => {
        // The drag the user starts and finishes inside the round trip: by the time the
        // response lands the activity is idle again, so only its version records it.
        harness.activity.begin();
        harness.activity.end();
        return snapshotResponse();
      }),
    );
    await tick();
    expect(harness.fetcher).toHaveBeenCalledTimes(1);
    expect(harness.applied).toEqual([]);
    harness.stop();
  });

  it("does not remember the tag of a snapshot it dropped", async () => {
    let interfere = true;
    const harness = start(
      vi.fn().mockImplementation(async () => {
        if (interfere) {
          harness.activity.begin();
          harness.activity.end();
        }
        return snapshotResponse('"abc"');
      }),
    );
    await tick();
    interfere = false;
    await tick();
    // Claiming the dropped tag would leave the board waiting on a change already sent.
    const [, second] = harness.fetcher.mock.calls;
    expect(second[1].headers).toBeUndefined();
    expect(harness.applied).toEqual([SNAPSHOT]);
    harness.stop();
  });

  it("keeps the browser cache out of the exchange", async () => {
    const harness = start(vi.fn().mockResolvedValue(snapshotResponse()));
    await tick();
    expect(harness.fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
    harness.stop();
  });

  it("stops polling once stopped", async () => {
    const harness = start(vi.fn().mockResolvedValue(snapshotResponse()));
    await tick();
    harness.stop();
    await tick();
    expect(harness.fetcher).toHaveBeenCalledTimes(1);
  });

  it("drops a body that is not a snapshot rather than applying it", async () => {
    const notASnapshot = new Response(JSON.stringify({ project: { id: "p1" } }), { status: 200 });
    const harness = start(vi.fn().mockResolvedValue(notASnapshot));
    await tick();
    expect(harness.applied).toEqual([]);
    harness.stop();
  });

  it("does not remember the tag of a body it could not read", async () => {
    const unreadable = () =>
      new Response(JSON.stringify({ nonsense: true }), { status: 200, headers: { etag: '"v1"' } });
    const harness = start(vi.fn().mockImplementation(async () => unreadable()));
    await tick();
    await tick();
    // No tag was recorded, so the second poll asks for the whole board again rather than
    // claiming to hold a snapshot it never applied.
    const [, second] = harness.fetcher.mock.calls;
    expect(second[1].headers).toBeUndefined();
    expect(harness.applied).toEqual([]);
    harness.stop();
  });
});
