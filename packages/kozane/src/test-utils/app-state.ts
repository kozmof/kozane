// Stub SvelteKit's `$app/state` module. Tests can set `page.url` before rendering.
export const page = {
  url: new URL("http://localhost/namespace-1"),
};
