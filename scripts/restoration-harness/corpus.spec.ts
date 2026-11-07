import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { readCorpus } from "../compatibility/read-corpus.mjs";
import { summarizeView } from "../compatibility/view-summary";

type Expected = { namespaceId?: string; view: Awaited<ReturnType<typeof summarizeView>> };
type Fixture = { id: string; file: string; sha256: string; size: number; expected: Expected[] };
for (const cohort of readCorpus(resolve("tests/compatibility/corpus"))) {
  for (const fixture of cohort.fixtures as Fixture[]) {
    for (const [index, expected] of fixture.expected.entries()) {
      test(`retained ${cohort.id}/${fixture.id} selection ${index} (${expected.view.kind})`, async ({
        page,
      }) => {
        await page.goto("http://127.0.0.1:4181");
        await expect(page.locator("body")).toHaveAttribute("data-harness", "ready");
        const restored = await page.evaluate(
          async ({ url, sha256, size, migrationId, namespaceId }) => {
            const harness = (window as any).restorationHarness;
            const compatibility = harness.corpusCompatibility(migrationId);
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Corpus fetch failed: ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            const digest = await crypto.subtle.digest("SHA-256", bytes);
            const actual = Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
            if (bytes.length !== size || actual !== sha256)
              throw new Error("Retained browser fixture changed");
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            const saved = JSON.stringify({
              schemaVersion: migrationId,
              savedAt: 0,
              db: btoa(binary),
            });
            sessionStorage.setItem("kozane-demo:session", saved);
            const result = await harness.run(namespaceId);
            return {
              result,
              compatibility,
              preserved: sessionStorage.getItem("kozane-demo:session") === saved,
              cleared: sessionStorage.getItem("kozane-demo:session") === null,
              fallbackKind:
                namespaceId === undefined || namespaceId === harness.manifest.sampleNamespaceId
                  ? "selected"
                  : "missing",
            };
          },
          {
            url: `/corpus/${cohort.id}/${fixture.file}`,
            sha256: fixture.sha256,
            size: fixture.size,
            migrationId: cohort.migrationId,
            namespaceId: expected.namespaceId,
          },
        );
        if (restored.compatibility === "same") {
          expect(restored.result).toMatchObject({ status: "ready", source: "restored" });
          expect(restored.preserved).toBe(true);
          expect(await page.evaluate(summarizeView, restored.result.view)).toEqual(expected.view);
        } else {
          expect(restored.result).toMatchObject({
            status: "ready",
            source: "sample",
            fallbackReason: "incompatible",
            view: { kind: restored.fallbackKind },
          });
          expect(restored.cleared).toBe(true);
        }
      });
    }
  }
}

test("a known earlier migration envelope falls back without reclassifying its data as corrupt", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4181");
  await expect(page.locator("body")).toHaveAttribute("data-harness", "ready");
  const outcome = await page.evaluate(async () => {
    const harness = (window as any).restorationHarness;
    const earlierId = harness.migrationIds.at(-2);
    if (!earlierId) throw new Error("This case requires a known earlier migration record");
    if (harness.corpusCompatibility(earlierId) !== "incompatible")
      throw new Error("Earlier ID was not classified as incompatible");
    // This is an envelope-policy case, not a claimed historical producer fixture.
    sessionStorage.setItem(
      "kozane-demo:session",
      JSON.stringify({ schemaVersion: earlierId, savedAt: 0, db: "AQ==" }),
    );
    const result = await harness.run();
    return { result, saved: sessionStorage.getItem("kozane-demo:session") };
  });
  expect(outcome).toMatchObject({
    result: { status: "ready", source: "sample", fallbackReason: "incompatible" },
    saved: null,
  });
});

test("a failed sample retains a known earlier migration envelope", async ({ page }) => {
  await page.goto("http://127.0.0.1:4181");
  await expect(page.locator("body")).toHaveAttribute("data-harness", "ready");
  await page.route("**/sample.db", (route) =>
    route.fulfill({ body: "broken asset", contentType: "application/octet-stream" }),
  );
  const outcome = await page.evaluate(async () => {
    const harness = (window as any).restorationHarness;
    const earlierId = harness.migrationIds.at(-2);
    if (!earlierId) throw new Error("This case requires a known earlier migration record");
    const saved = JSON.stringify({ schemaVersion: earlierId, savedAt: 0, db: "AQ==" });
    sessionStorage.setItem("kozane-demo:session", saved);
    const result = await harness.run();
    return { result, preserved: sessionStorage.getItem("kozane-demo:session") === saved };
  });
  expect(outcome).toMatchObject({
    result: { status: "unavailable", action: "reload", kind: "asset" },
    preserved: true,
  });
});
