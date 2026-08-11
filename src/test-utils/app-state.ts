// Test stub for SvelteKit's virtual `$app/state` module, which only exists in a real
// Vite/SvelteKit build. Only `page.url` is used by the components under test; a test that
// needs a different URL assigns to it before rendering.
export const page = {
  url: new URL("http://localhost/project-1"),
};
