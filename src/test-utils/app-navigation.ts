// Test stub for SvelteKit's virtual `$app/navigation` module, which only exists in a
// real Vite/SvelteKit build. Tests that care about navigation spy on these with
// `vi.spyOn(navigation, "goto")`; the defaults do nothing, the way a router that is not
// running would.
export function goto(_url: string | URL): Promise<void> {
  return Promise.resolve();
}

export function replaceState(_url: string | URL, _state: Record<string, unknown>): void {}
