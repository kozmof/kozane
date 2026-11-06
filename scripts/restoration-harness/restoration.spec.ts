import { expect, test } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("http://127.0.0.1:4181");
  await expect(page.locator("body")).toHaveAttribute("data-harness", "ready");
});
test("validates fresh sample bytes under the demo CSP", async ({ page }) => {
  const result = await page.evaluate(async () => (window as any).restorationHarness.run());
  expect(result).toMatchObject({ status: "ready", source: "sample", view: { kind: "selected" } });
});
test("restores matching bytes and preserves an explicit missing namespace", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const harness = (window as any).restorationHarness;
    const bytes = new Uint8Array(await (await fetch("/sample.db")).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    sessionStorage.setItem(
      "kozane-demo:session",
      JSON.stringify({ schemaVersion: harness.schemaVersion, savedAt: 0, db: btoa(binary) }),
    );
    const result = await harness.run("missing-namespace");
    return { result, preserved: sessionStorage.getItem("kozane-demo:session") !== null };
  });
  expect(result).toMatchObject({
    result: { status: "ready", source: "restored", view: { kind: "missing" } },
    preserved: true,
  });
});
test("deletes malformed recovery only after validated sample fallback", async ({ page }) => {
  const result = await page.evaluate(async () => {
    sessionStorage.setItem("kozane-demo:session", "malformed");
    const result = await (window as any).restorationHarness.run();
    return { result, saved: sessionStorage.getItem("kozane-demo:session") };
  });
  expect(result).toMatchObject({
    result: { status: "ready", source: "sample", fallbackReason: "malformed" },
    saved: null,
  });
});
test("preserves rejected recovery when sample asset verification fails", async ({ page }) => {
  await page.route("**/sample.db", (route) =>
    route.fulfill({ body: "invalid asset", contentType: "application/octet-stream" }),
  );
  const result = await page.evaluate(async () => {
    sessionStorage.setItem("kozane-demo:session", "malformed");
    const result = await (window as any).restorationHarness.run();
    return { result, saved: sessionStorage.getItem("kozane-demo:session") };
  });
  expect(result).toMatchObject({
    result: { status: "unavailable", action: "reload", kind: "asset" },
    saved: "malformed",
  });
});
test("discards superseded view failures before fallback deletion", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const harness = (window as any).restorationHarness;
    sessionStorage.setItem("kozane-demo:session", "malformed");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    const startup = harness.start("obsolete-id", async (id: string) => {
      if (first && id === "obsolete-id") {
        first = false;
        entered();
        await gate;
        throw new Error("obsolete read failure");
      }
    });
    await waiting;
    const before = sessionStorage.getItem("kozane-demo:session");
    startup.navigate("current-missing-id");
    release();
    return {
      result: await startup.result,
      before,
      after: sessionStorage.getItem("kozane-demo:session"),
    };
  });
  expect(result).toMatchObject({
    result: { status: "ready", source: "sample", view: { kind: "missing" } },
    before: "malformed",
    after: null,
  });
});
test("preserves the copy after an unclassified initial service-read failure", async ({ page }) => {
  const result = await page.evaluate(async () => {
    sessionStorage.setItem("kozane-demo:session", "malformed");
    const startup = (window as any).restorationHarness.start(undefined, async () => {
      throw new Error("service read failed");
    });
    return { result: await startup.result, saved: sessionStorage.getItem("kozane-demo:session") };
  });
  expect(result).toMatchObject({
    result: { status: "unavailable", action: "retry", kind: "unknown" },
    saved: "malformed",
  });
});
test("preserves the copy on a worker transport failure", async ({ page }) => {
  const result = await page.evaluate(async () => {
    sessionStorage.setItem("kozane-demo:session", "malformed");
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      postMessage(message: any, transfer?: Transferable[] | StructuredSerializeOptions) {
        if (message.method === "open") {
          this.terminate();
          this.dispatchEvent(new Event("error"));
          return;
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
    try {
      return {
        result: await (window as any).restorationHarness.run(),
        saved: sessionStorage.getItem("kozane-demo:session"),
      };
    } finally {
      window.Worker = OriginalWorker;
    }
  });
  expect(result).toMatchObject({
    result: { status: "unavailable", action: "retry", kind: "unknown" },
    saved: "malformed",
  });
});
for (const asset of ["worker.js", "sqlite3.wasm"]) {
  test(`requires reload and preserves recovery after ${asset} hash mismatch`, async ({ page }) => {
    await page.route(`**/${asset}`, (route) =>
      route.fulfill({
        body: "invalid asset",
        contentType: asset.endsWith("wasm") ? "application/wasm" : "text/javascript",
      }),
    );
    const result = await page.evaluate(async () => {
      sessionStorage.setItem("kozane-demo:session", "malformed");
      return {
        result: await (window as any).restorationHarness.run(),
        saved: sessionStorage.getItem("kozane-demo:session"),
      };
    });
    expect(result).toMatchObject({
      result: { status: "unavailable", action: "reload", kind: "asset" },
      saved: "malformed",
    });
  });
}

test("preserves recovery after an executed open loses its reply", async ({ page }) => {
  const result = await page.evaluate(async () => {
    sessionStorage.setItem("kozane-demo:session", "malformed");
    const OriginalWorker = window.Worker;
    let dropped = false;
    window.Worker = class extends OriginalWorker {
      private lostId: number | undefined;
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener("message", (event) => {
          if (event.data.id === this.lostId) {
            dropped = true;
            event.stopImmediatePropagation();
          }
        });
      }
      postMessage(message: any, options?: Transferable[] | StructuredSerializeOptions) {
        if (message.method === "open" && this.lostId === undefined) this.lostId = message.id;
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      }
    };
    try {
      return {
        result: await (window as any).restorationHarness.run(undefined, { rpcTimeoutMs: 2000 }),
        dropped,
        saved: sessionStorage.getItem("kozane-demo:session"),
      };
    } finally {
      window.Worker = OriginalWorker;
    }
  });
  expect(result).toMatchObject({
    result: { status: "unavailable", action: "retry", kind: "unknown" },
    dropped: true,
    saved: "malformed",
  });
});
test("a superseded startup cannot delete a newer restored copy", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const harness = (window as any).restorationHarness;
    sessionStorage.setItem("kozane-demo:session", "malformed");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const old = harness.start(undefined, async () => {
      entered();
      await gate;
    });
    await waiting;
    const bytes = new Uint8Array(await (await fetch("/sample.db")).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const saved = JSON.stringify({
      schemaVersion: harness.schemaVersion,
      savedAt: 1,
      db: btoa(binary),
    });
    sessionStorage.setItem("kozane-demo:session", saved);
    const current = await harness.run();
    release();
    return {
      old: await old.result,
      current,
      currentOwns: harness.isCurrent(current),
      preserved: sessionStorage.getItem("kozane-demo:session") === saved,
    };
  });
  expect(result).toMatchObject({
    old: { status: "superseded" },
    current: { status: "ready", source: "restored" },
    currentOwns: true,
    preserved: true,
  });
});
test("generation replacement suppresses late startup readiness and deletion", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const harness = (window as any).restorationHarness;
    sessionStorage.setItem("kozane-demo:session", "malformed");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const old = harness.start(undefined, async () => {
      entered();
      await gate;
    });
    await waiting;
    harness.replaceGeneration();
    sessionStorage.setItem("kozane-demo:session", "newer copy");
    release();
    const obsolete = await old.result;
    const saved = sessionStorage.getItem("kozane-demo:session");
    const current = await harness.run();
    return { obsolete, saved, current };
  });
  expect(result).toMatchObject({
    obsolete: { status: "superseded" },
    saved: "newer copy",
    current: { status: "ready", generation: 1 },
  });
});
test("a late verified worker from an obsolete attempt cannot open a database", async ({ page }) => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  await page.route("**/worker.js", async (route) => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
    await route.continue();
  });
  await page.evaluate(() => {
    sessionStorage.setItem("kozane-demo:session", "malformed");
    (window as any).obsoleteStartup = (window as any).restorationHarness.start();
  });
  await waiting;
  const current = await page.evaluate(async () => {
    const harness = (window as any).restorationHarness;
    const bytes = new Uint8Array(await (await fetch("/sample.db")).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const saved = JSON.stringify({
      schemaVersion: harness.schemaVersion,
      savedAt: 0,
      db: btoa(binary),
    });
    sessionStorage.setItem("kozane-demo:session", saved);
    return { result: await harness.run(), saved };
  });
  release();
  const late = await page.evaluate(async () => ({
    result: await (window as any).obsoleteStartup.result,
    saved: sessionStorage.getItem("kozane-demo:session"),
  }));
  expect(current.result).toMatchObject({ status: "ready", source: "restored" });
  expect(late).toEqual({ result: { status: "superseded" }, saved: current.saved });
});
test("stages reset in another worker and resets URL and data without network access", async ({
  page,
}) => {
  await page.evaluate(async () => {
    history.replaceState(null, "", "/tags/?namespaceId=old#tag=private");
    const session = await (window as any).restorationHarness.openSession();
    if (session.status !== "ready") throw new Error("Session failed to open");
    await session.addCard("Retained user edit");
    sessionStorage.setItem("kozane-demo:session", "older copy");
    (window as any).retainedResetSession = session;
  });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  const result = await page.evaluate(async () => {
    const session = (window as any).retainedResetSession;
    try {
      const reset = await session.reset();
      const view = await session.read();
      return {
        reset,
        view,
        url: location.pathname + location.search + location.hash,
        saved: sessionStorage.getItem("kozane-demo:session"),
        sample: (window as any).restorationHarness.manifest.sampleNamespaceId,
      };
    } finally {
      await session.close();
    }
  });
  expect(result.reset).toMatchObject({ status: "ready", state: { generation: 1, liveWorkers: 1 } });
  expect(result.view.snapshot.snapshot.cards).toHaveLength(1);
  expect(result.url).toBe(`/board/?namespaceId=${result.sample}`);
  expect(result.saved).toBeNull();
  expect(requests).toEqual([]);
});
test("keeps the live worker, user edit, saved copy and URL after reset read failure", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const harness = (window as any).restorationHarness;
    const session = await harness.openSession();
    if (session.status !== "ready") throw new Error("Session failed to open");
    try {
      await session.addCard("Edit survives failed reset");
      history.replaceState(null, "", "/map/?namespaceId=user#search=private");
      sessionStorage.setItem("kozane-demo:session", "saved copy");
      const reset = await session.reset({
        beforeView: async () => {
          throw new Error("unclassified read failure");
        },
      });
      const view = await session.read();
      return {
        reset,
        view,
        state: session.state(),
        url: location.pathname + location.search + location.hash,
        saved: sessionStorage.getItem("kozane-demo:session"),
      };
    } finally {
      await session.close();
    }
  });
  expect(result.reset).toMatchObject({ status: "unavailable", action: "retry", kind: "unknown" });
  expect(result.state).toMatchObject({ generation: 0, liveWorkers: 1 });
  expect(result.view.snapshot.snapshot.cards.map((card: any) => card.content)).toContain(
    "Edit survives failed reset",
  );
  expect(result.saved).toBe("saved copy");
  expect(result.url).toBe("/map/?namespaceId=user#search=private");
});
for (const fixtureSQL of [
  "DROP INDEX scope_rel_card",
  "PRAGMA foreign_keys=OFF; INSERT INTO scope(id,name) VALUES ('dangling','Outside current view'); INSERT INTO scope_rel(scope_id,card_id) VALUES ('dangling','absent-card')",
]) {
  test(`rejects a staged reset defect and preserves the current worker: ${fixtureSQL.split(";")[0]}`, async ({
    page,
  }) => {
    const result = await page.evaluate(async (sql) => {
      const session = await (window as any).restorationHarness.openSession();
      if (session.status !== "ready") throw new Error("Session failed to open");
      try {
        await session.addCard("Live content");
        sessionStorage.setItem("kozane-demo:session", "saved copy");
        const reset = await session.reset({ fixtureSQL: sql });
        const view = await session.read();
        return {
          reset,
          view,
          state: session.state(),
          saved: sessionStorage.getItem("kozane-demo:session"),
          url: location.href,
        };
      } finally {
        await session.close();
      }
    }, fixtureSQL);
    expect(result.reset).toMatchObject({
      status: "unavailable",
      action: "reload",
      kind: "database_content",
    });
    expect(result.state).toMatchObject({ generation: 0, liveWorkers: 1 });
    expect(result.view.snapshot.snapshot.cards).toHaveLength(2);
    expect(result.saved).toBe("saved copy");
    expect(new URL(result.url).pathname).toBe("/");
  });
}
test("successful reset discloses failed saved-copy deletion while activating fresh data", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const session = await (window as any).restorationHarness.openSession();
    if (session.status !== "ready") throw new Error("Session failed to open");
    try {
      sessionStorage.setItem("kozane-demo:session", "older copy");
      const reset = await session.reset({ deleteFails: true });
      return {
        reset,
        view: await session.read(),
        saved: sessionStorage.getItem("kozane-demo:session"),
      };
    } finally {
      await session.close();
    }
  });
  expect(result.reset).toMatchObject({
    status: "ready",
    recoveryUnavailable: true,
    olderCopyMayRestore: true,
    state: { generation: 1, liveWorkers: 1 },
  });
  expect(result.view.snapshot.snapshot.cards).toHaveLength(1);
  expect(result.saved).toBe("older copy");
});
test("invalid test RPC deadlines reject before worker creation or asset fetching", async ({
  page,
}) => {
  const requests: string[] = [];
  let workers = 0;
  page.on("request", (request) => requests.push(request.url()));
  page.on("worker", () => {
    workers++;
  });
  const errors = await page.evaluate(async () => {
    const errors: string[] = [];
    for (const rpcTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      try {
        await (window as any).restorationHarness.run(undefined, { rpcTimeoutMs });
        errors.push("accepted");
      } catch (error) {
        errors.push(error instanceof Error ? error.name : "unknown");
      }
    }
    return errors;
  });
  expect(errors).toEqual(["RangeError", "RangeError", "RangeError", "RangeError"]);
  expect(workers).toBe(0);
  expect(requests).toEqual([]);
});
