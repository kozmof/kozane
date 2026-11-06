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
