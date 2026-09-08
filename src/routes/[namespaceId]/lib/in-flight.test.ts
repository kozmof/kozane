import { describe, expect, it } from "vitest";
import { InFlight } from "./in-flight.js";

describe("InFlight", () => {
  it("starts idle", () => {
    expect(new InFlight().idle).toBe(true);
  });

  it("is busy while work is open and idle once it closes", () => {
    const activity = new InFlight();
    activity.begin();
    expect(activity.idle).toBe(false);
    activity.end();
    expect(activity.idle).toBe(true);
  });

  it("stays busy until every open piece of work has ended", () => {
    const activity = new InFlight();
    activity.begin();
    activity.begin();
    activity.end();
    expect(activity.idle).toBe(false);
    activity.end();
    expect(activity.idle).toBe(true);
  });

  it("does not count below zero when an end arrives unpaired", () => {
    const activity = new InFlight();
    activity.end();
    activity.begin();
    // Were the count negative, this `begin` would leave it at zero and report idle.
    expect(activity.idle).toBe(false);
  });

  it("reports a begin/end pair that happened since a noted version", () => {
    const activity = new InFlight();
    const version = activity.version;
    activity.begin();
    activity.end();
    // Idle again, and the count alone could not tell that anything had happened.
    expect(activity.idle).toBe(true);
    expect(activity.unchangedSince(version)).toBe(false);
  });

  it("reports no change when nothing happened", () => {
    const activity = new InFlight();
    expect(activity.unchangedSince(activity.version)).toBe(true);
  });

  it("reports a change while work is still open", () => {
    const activity = new InFlight();
    const version = activity.version;
    activity.begin();
    expect(activity.unchangedSince(version)).toBe(false);
  });

  it("holds the activity open for the duration of tracked work", async () => {
    const activity = new InFlight();
    let idleDuring: boolean | null = null;
    await activity.track(async () => {
      idleDuring = activity.idle;
    });
    expect(idleDuring).toBe(false);
    expect(activity.idle).toBe(true);
  });

  it("closes the activity when tracked work throws", async () => {
    const activity = new InFlight();
    await expect(
      activity.track(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(activity.idle).toBe(true);
  });

  it("hands back what the tracked work returned", async () => {
    await expect(new InFlight().track(async () => "result")).resolves.toBe("result");
  });
});
