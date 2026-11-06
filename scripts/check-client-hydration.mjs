import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/** Exercise compiled browser hydration in a DOM without running browser E2E. */
export async function checkClientHydration(renderCapabilityViews) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  const saved = new Map();
  const install = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const warnings = [];
  const warn = console.warn,
    error = console.error;
  try {
    install("window", dom.window);
    install("document", dom.window.document);
    install("navigator", dom.window.navigator);
    for (const key of [
      "Element",
      "Node",
      "Document",
      "DocumentFragment",
      "Event",
      "EventTarget",
      "CustomEvent",
      "MouseEvent",
      "KeyboardEvent",
      "FocusEvent",
      "InputEvent",
      "PointerEvent",
      "MutationObserver",
      "DOMException",
      "Text",
      "Comment",
      "Range",
      "Selection",
      "Window",
      ...Object.getOwnPropertyNames(dom.window).filter((key) => /^(HTML|SVG).*Element$/.test(key)),
    ]) {
      if (dom.window[key]) install(key, dom.window[key]);
    }
    install("getComputedStyle", dom.window.getComputedStyle.bind(dom.window));
    install("requestAnimationFrame", () => 0);
    install("cancelAnimationFrame", () => {});
    install(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    dom.window.Element.prototype.scrollTo = function (options) {
      this.scrollLeft = options.left ?? this.scrollLeft;
      this.scrollTop = options.top ?? this.scrollTop;
    };
    dom.window.Element.prototype.scrollBy = function (options) {
      this.scrollLeft += options.left ?? 0;
      this.scrollTop += options.top ?? 0;
    };
    for (const name of ["setPointerCapture", "releasePointerCapture"])
      dom.window.Element.prototype[name] = () => {};
    dom.window.Element.prototype.hasPointerCapture = () => false;
    console.warn = (...args) => warnings.push(args.map(String).join(" "));
    console.error = (...args) => warnings.push(args.map(String).join(" "));
    const { hydrateCapabilityViews } = await import(
      new URL("../tmp/client-hydration/consumer.js", import.meta.url)
    );
    for (const writable of [true, false])
      for (const persistent of [true, false]) {
        const payload = JSON.parse(
          JSON.stringify({
            capabilities: {
              writable,
              persistent,
              taskspaces: true,
              externalWrites: true,
              auth: false,
            },
            lifetimeNotice: persistent
              ? undefined
              : "Database changes last for this server process and are lost when it stops.",
          }),
        );
        const rendered = renderCapabilityViews(payload.capabilities, payload.lifetimeNotice);
        dom.window.document.body.innerHTML = `<div id="index">${rendered.index}</div><div id="board">${rendered.board}</div>`;
        assert.equal(
          !!dom.window.document.querySelector('#index [aria-label="Create namespace"]'),
          writable,
          "SSR namespace controls must match Node capabilities",
        );
        assert.equal(
          !!dom.window.document.querySelector('#board [aria-label="Create card"]'),
          writable,
          "SSR board controls must match Node capabilities",
        );
        const result = await hydrateCapabilityViews(payload.capabilities, payload.lifetimeNotice);
        assert.equal(result.kind, "http", "Read-only and server-memory pages must retain HTTP");
        assert.deepEqual(result.capabilities, payload.capabilities);
        assert.equal(result.namespaceCreate, writable);
        assert.equal(result.cardCreate, writable);
        assert.equal(
          result.modeText.filter((text) => text.includes("Read-only workspace.")).length,
          writable ? 0 : 2,
        );
        assert.equal(
          result.modeText.filter((text) => text.includes("server process")).length,
          persistent ? 0 : 2,
        );
        assert.ok(
          result.refreshed && result.calls.some((url) => url.endsWith("/api/namespaces")),
          "Hydration must refresh the Node namespace list through HTTP",
        );
        assert.ok(
          result.modeText.every(
            (text) => !/sessionStorage|reload recovery|browser session/.test(text),
          ),
          "Server memory must not advertise browser recovery",
        );
      }
    assert.equal(warnings.length, 0, warnings.join("\n"));
    console.log("Four Node capability modes passed SSR/hydration agreement checks.");
  } finally {
    console.warn = warn;
    console.error = error;
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}
