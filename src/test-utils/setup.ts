import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/svelte";
import { afterEach } from "vitest";

if (typeof HTMLElement.prototype.scrollBy !== "function") {
  Object.defineProperty(HTMLElement.prototype, "scrollBy", { value: () => undefined });
}

// Stub `ResizeObserver` because jsdom does not measure layout. Supply dimensions explicitly in
// component tests and use Playwright for real layout checks.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

// Stub pointer capture, which jsdom does not implement. Browser drag handlers can then use the
// same API in component tests.
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
  // Clear session storage so one test's selected layer cannot affect the next.
  globalThis.sessionStorage?.clear();
});
