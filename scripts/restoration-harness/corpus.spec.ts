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
            if (harness.schemaVersion !== migrationId)
              throw new Error("A new migration ID needs explicit incompatible-corpus expectations");
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
            return { result, preserved: sessionStorage.getItem("kozane-demo:session") === saved };
          },
          {
            url: `/corpus/${cohort.id}/${fixture.file}`,
            sha256: fixture.sha256,
            size: fixture.size,
            migrationId: cohort.migrationId,
            namespaceId: expected.namespaceId,
          },
        );
        expect(restored.result).toMatchObject({ status: "ready", source: "restored" });
        expect(restored.preserved).toBe(true);
        expect(await page.evaluate(summarizeView, restored.result.view)).toEqual(expected.view);
      });
    }
  }
}
