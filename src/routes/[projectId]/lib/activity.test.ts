import { describe, expect, it } from "vitest";
import { Activity } from "./activity.js";

describe("Activity", () => {
  it("starts idle", () => {
    expect(new Activity().idle).toBe(true);
  });

  it("is busy while work is open and idle once it closes", () => {
    const activity = new Activity();
    activity.begin();
    expect(activity.idle).toBe(false);
    activity.end();
    expect(activity.idle).toBe(true);
  });

  it("stays busy until every open piece of work has ended", () => {
    const activity = new Activity();
    activity.begin();
    activity.begin();
    activity.end();
    expect(activity.idle).toBe(false);
    activity.end();
    expect(activity.idle).toBe(true);
  });

  it("does not count below zero when an end arrives unpaired", () => {
    const activity = new Activity();
    activity.end();
    activity.begin();
    // Were the count negative, this `begin` would leave it at zero and report idle.
    expect(activity.idle).toBe(false);
  });

  it("reports a begin/end pair that happened since a noted version", () => {
    const activity = new Activity();
    const version = activity.version;
    activity.begin();
    activity.end();
    // Idle again, and the count alone could not tell that anything had happened.
    expect(activity.idle).toBe(true);
    expect(activity.unchangedSince(version)).toBe(false);
  });

  it("reports no change when nothing happened", () => {
    const activity = new Activity();
    expect(activity.unchangedSince(activity.version)).toBe(true);
  });

  it("reports a change while work is still open", () => {
    const activity = new Activity();
    const version = activity.version;
    activity.begin();
    expect(activity.unchangedSince(version)).toBe(false);
  });

  it("holds the activity open for the duration of tracked work", async () => {
    const activity = new Activity();
    let idleDuring: boolean | null = null;
    await activity.track(async () => {
      idleDuring = activity.idle;
    });
    expect(idleDuring).toBe(false);
    expect(activity.idle).toBe(true);
  });

  it("closes the activity when tracked work throws", async () => {
    const activity = new Activity();
    await expect(
      activity.track(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(activity.idle).toBe(true);
  });

  it("hands back what the tracked work returned", async () => {
    await expect(new Activity().track(async () => "result")).resolves.toBe("result");
  });
});
