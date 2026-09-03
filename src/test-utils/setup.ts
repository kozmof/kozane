import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/svelte";
import { afterEach } from "vitest";

if (typeof HTMLElement.prototype.scrollBy !== "function") {
  Object.defineProperty(HTMLElement.prototype, "scrollBy", { value: () => undefined });
}

// jsdom has no layout and so no ResizeObserver, which is what Svelte's `bind:clientHeight`
// is built on. A stub that observes nothing is the honest stand-in: an element's size is
// zero here and never changes, so a real implementation would have nothing to report
// either. Components that need a size in a test are given one; components that need one to
// be measured belong in the Playwright specs.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

// jsdom raises pointer events but implements none of the capture API behind them, and a
// drag that is not captured is a drag that stops the moment the pointer leaves the element.
// Stubs rather than a guard at each call site: capture is in every browser the app runs in,
// so a `?.` in the page would be describing this file rather than anything real.
for (const name of ["setPointerCapture", "releasePointerCapture"] as const) {
  if (typeof Element.prototype[name] !== "function") {
    Object.defineProperty(Element.prototype, name, { value: () => undefined });
  }
}
if (typeof Element.prototype.hasPointerCapture !== "function") {
  Object.defineProperty(Element.prototype, "hasPointerCapture", { value: () => false });
}

afterEach(() => {
  cleanup();
  // The page remembers the layer being worked on in sessionStorage, which outlives a
  // render: without this, one test's layer selection becomes the next test's starting
  // state.
  globalThis.sessionStorage?.clear();
});
