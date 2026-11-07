import { chromium, expect, test } from "@playwright/test";
import { openRawChromium, evaluateUntil, evaluateOnce } from "./raw-chromium";
import { installSuspensionDriver, type SuspensionStage } from "./suspension-driver";
const stages: SuspensionStage[] = [
  "worker-fetch",
  "worker-body",
  "worker-hash",
  "wasm-compile",
  "initialize",
  "validation",
  "validation-reply",
];
test.beforeEach(async ({ page }) => {
  await page.goto("http://127.0.0.1:4181");
  await expect(page.locator("body")).toHaveAttribute("data-harness", "ready");
});
for (const stage of stages) {
  test(`confirmed suspension retains the budget during ${stage}`, async ({ page }) => {
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(60_000);
    await page.evaluate(installSuspensionDriver, stage);
    try {
      await expect
        .poll(() => page.evaluate(() => (window as any).suspensionCase.entered))
        .toBe(true);
      await page.evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
      );
      await page.clock.fastForward(90_000);
      expect(
        await page.evaluate(() => ({
          finished: (window as any).suspensionCase.finished,
          saved: sessionStorage.getItem("kozane-demo:session"),
        })),
      ).toEqual({ finished: false, saved: "preserved malformed copy" });
      await page.evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
      );
      await page.clock.resume();
      if (
        stage === "wasm-compile" ||
        stage === "initialize" ||
        stage === "validation" ||
        stage === "validation-reply"
      ) {
        await expect
          .poll(() =>
            page.evaluate(() => {
              const state = (window as any).suspensionCase;
              return state.probeReplies > state.baselineProbes;
            }),
          )
          .toBe(true);
        if (stage === "validation")
          await expect
            .poll(() =>
              page.evaluate(() => {
                const state = (window as any).suspensionCase;
                return state.connectionReplies > state.baselineConnections;
              }),
            )
            .toBe(true);
        else
          expect(await page.evaluate(() => (window as any).suspensionCase.connectionReplies)).toBe(
            0,
          );
      } else expect(await page.evaluate(() => (window as any).suspensionCase.probeReplies)).toBe(0);
      await page.evaluate(() => (window as any).suspensionCase.release());
      const result = await page.evaluate(async () => await (window as any).suspensionCase.result);
      expect(result).toMatchObject({
        status: "ready",
        source: "sample",
        fallbackReason: "malformed",
      });
      expect(await page.evaluate(() => sessionStorage.getItem("kozane-demo:session"))).toBeNull();
      if (stage === "validation-reply")
        expect(
          await page.evaluate(() => (window as any).suspensionCase.connectionReplies),
        ).toBeGreaterThan(0);
    } finally {
      await page.clock.resume();
      await page.evaluate(() => {
        (window as any).suspensionCase?.release();
        (window as any).suspensionCase?.cleanup();
      });
    }
  });
}
test("supported freeze/resume signals preserve a pending validation budget", async ({ page }) => {
  const supported = await page.evaluate(() => "onfreeze" in document || "onresume" in document);
  test.skip(!supported, "This Chromium does not expose document freeze/resume events");
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(60_000);
  await page.evaluate(installSuspensionDriver, "validation" as SuspensionStage);
  try {
    await expect.poll(() => page.evaluate(() => (window as any).suspensionCase.entered)).toBe(true);
    await page.evaluate(() => document.dispatchEvent(new Event("freeze")));
    await page.clock.fastForward(90_000);
    expect(await page.evaluate(() => (window as any).suspensionCase.finished)).toBe(false);
    await page.evaluate(() => document.dispatchEvent(new Event("resume")));
    await page.clock.resume();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = (window as any).suspensionCase;
          return state.connectionReplies > state.baselineConnections;
        }),
      )
      .toBe(true);
    await page.evaluate(() => (window as any).suspensionCase.release());
    expect(
      await page.evaluate(async () => await (window as any).suspensionCase.result),
    ).toMatchObject({ status: "ready", source: "sample" });
  } finally {
    await page.clock.resume();
    await page.evaluate(() => {
      (window as any).suspensionCase?.release();
      (window as any).suspensionCase?.cleanup();
    });
  }
});
test("a real BFCache round trip retains the live worker and unsaved edits", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  // Playwright Page does not support BFCache. Keep this browser outside its lifecycle instrumentation.
  const browser = await openRawChromium(chromium.executablePath());
  const { cdp } = browser;
  let sessionId: string | undefined;
  try {
    const target = await cdp.send("Target.createTarget", { url: "about:blank" });
    sessionId = (
      await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })
    ).sessionId;
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:4181" }, sessionId);
    await evaluateUntil(cdp, sessionId!, "document.body?.dataset.harness === 'ready'");
    const token = await evaluateOnce(
      cdp,
      sessionId!,
      `(async () => {
      const session = await window.restorationHarness.openSession(undefined, { rpcTimeoutMs: 2000, healthTimeoutMs: 2000 });
      if (session.status !== "ready") throw new Error("Session failed");
      await session.addCard("Unsaved BFCache edit");
      sessionStorage.setItem("kozane-demo:session", "preserved copy");
      const state = { session, token: crypto.randomUUID(), restored: false };
      window.bfcacheCase = state;
      window.addEventListener("pageshow", event => { if (event.persisted) state.restored = true; });
      return state.token;
    })()`,
    );
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:4181/away" }, sessionId);
    await evaluateUntil(
      cdp,
      sessionId!,
      "location.pathname === '/away' && document.readyState === 'complete'",
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const history = await cdp.send("Page.getNavigationHistory", {}, sessionId);
    await cdp.send(
      "Page.navigateToHistoryEntry",
      { entryId: history.entries[history.currentIndex - 1].id },
      sessionId,
    );
    await evaluateUntil(
      cdp,
      sessionId!,
      "location.pathname === '/' && document.body?.dataset.harness === 'ready'",
    );
    const result = await evaluateOnce(
      cdp,
      sessionId!,
      `(async () => {
      const state = window.bfcacheCase;
      if (!state) return { restored: false, reasons: performance.getEntriesByType("navigation")[0]?.notRestoredReasons?.toJSON() };
      try { return { token: state.token, restored: state.restored, view: await state.session.read(), saved: sessionStorage.getItem("kozane-demo:session") }; }
      finally { await state.session.close(); }
    })()`,
    );
    const diagnostics = {
      result,
      events: cdp.events.filter((event) => event.method === "Page.backForwardCacheNotUsed"),
    };
    await testInfo.attach("bfcache-diagnostics", {
      body: JSON.stringify(diagnostics, null, 2),
      contentType: "application/json",
    });
    expect(result, JSON.stringify(diagnostics)).toMatchObject({
      token,
      restored: true,
      saved: "preserved copy",
    });
    expect(result.view.snapshot.snapshot.cards.map((card: any) => card.content)).toContain(
      "Unsaved BFCache edit",
    );
  } finally {
    try {
      await testInfo.attach("bfcache-protocol-events", {
        body: JSON.stringify(cdp.events, null, 2),
        contentType: "application/json",
      });
    } finally {
      await browser.close();
    }
  }
});
test("a hidden but executing page still expires a stalled database reply", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const OriginalWorker = window.Worker;
    let stall = false;
    window.Worker = class extends OriginalWorker {
      postMessage(message: any, options?: Transferable[] | StructuredSerializeOptions) {
        if (
          stall &&
          typeof message.sql === "string" &&
          message.sql.toLowerCase().includes("pragma integrity_check")
        )
          return;
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      }
    };
    let session: any;
    try {
      session = await (window as any).restorationHarness.openSession(undefined, {
        rpcTimeoutMs: 2000,
      });
      if (session.status !== "ready") throw new Error("Session failed");
      sessionStorage.setItem("kozane-demo:session", "preserved copy");
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      stall = true;
      let rejected = false;
      try {
        await session.read();
      } catch {
        rejected = true;
      }
      return {
        rejected,
        state: session.state(),
        saved: sessionStorage.getItem("kozane-demo:session"),
      };
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
      if (session?.status === "ready") await session.close();
      window.Worker = OriginalWorker;
    }
  });
  expect(result).toMatchObject({
    rejected: true,
    state: { liveWorkers: 0 },
    saved: "preserved copy",
  });
});
test("repeated ambiguous gaps exhaust a stalled pre-worker asset budget", async ({ page }) => {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(60_000);
  await page.evaluate(installSuspensionDriver, "worker-fetch" as SuspensionStage);
  try {
    await expect.poll(() => page.evaluate(() => (window as any).suspensionCase.entered)).toBe(true);
    for (let gap = 0; gap < 30; gap++) {
      await page.clock.fastForward(5_000);
      await page.clock.runFor(2);
    }
    const result = await page.evaluate(async () => ({
      report: await (window as any).suspensionCase.result,
      saved: sessionStorage.getItem("kozane-demo:session"),
      probes: (window as any).suspensionCase.probeReplies,
    }));
    expect(result).toMatchObject({
      report: { status: "unavailable", action: "retry", kind: "unknown" },
      saved: "preserved malformed copy",
      probes: 0,
    });
  } finally {
    await page.clock.resume();
    await page.evaluate(() => {
      (window as any).suspensionCase?.release();
      (window as any).suspensionCase?.cleanup();
    });
  }
});
