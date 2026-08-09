import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/svelte";
import { afterEach } from "vitest";

if (typeof HTMLElement.prototype.scrollBy !== "function") {
  Object.defineProperty(HTMLElement.prototype, "scrollBy", { value: () => undefined });
}

afterEach(() => cleanup());
