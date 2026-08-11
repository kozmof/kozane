import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/svelte";
import { afterEach } from "vitest";

if (typeof HTMLElement.prototype.scrollBy !== "function") {
  Object.defineProperty(HTMLElement.prototype, "scrollBy", { value: () => undefined });
}

afterEach(() => {
  cleanup();
  // The page remembers the layer being worked on in sessionStorage, which outlives a
  // render: without this, one test's layer selection becomes the next test's starting
  // state.
  globalThis.sessionStorage?.clear();
});
